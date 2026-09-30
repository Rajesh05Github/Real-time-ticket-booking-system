import {
  lockReservation,
  prisma,
  writeOutboxEvent,
  type Order,
  type Payment,
  type Prisma,
  type Ticket,
} from '@flashsale/database';
import { CHECKOUT_TIMEOUT_SECONDS } from '@flashsale/shared';

import { issueTicketsForOrder } from '../tickets/ticket.repository.js';

export type OrderWithPayments = Order & { payments: Payment[]; tickets: Ticket[] };

/**
 * `amountMinor` is `bigint` on both Order and Payment (headroom for a
 * SUM across up to MAX_SEATS_PER_RESERVATION seats, schema.prisma's own
 * comment) -- and `JSON.stringify` cannot serialize a `bigint` at all,
 * it throws. Rather than a global `BigInt.prototype.toJSON` patch (a
 * common but silent, action-at-a-distance fix), this follows the same
 * explicit pattern event-cache.ts's `SerializedEvent` already
 * established for Date->string: the wire type says honestly that this
 * field is a string over HTTP, and one function is the single place
 * that conversion happens.
 */
export type SerializedPayment = Omit<Payment, 'amountMinor'> & { amountMinor: string };
export type SerializedOrder = Omit<Order, 'amountMinor'> & {
  amountMinor: string;
  payments: SerializedPayment[];
  // Ticket has no bigint fields, so no per-field conversion needed here --
  // unlike payments, it passes through serializeOrder unchanged. Declared
  // explicitly anyway (not left to an untyped spread) so this type
  // honestly matches what GET /orders/:id actually returns, now that
  // Phase 14 wires ticket issuance into the same transaction this file
  // already builds Orders from.
  tickets: Ticket[];
};

export function serializeOrder(order: OrderWithPayments): SerializedOrder {
  return {
    ...order,
    amountMinor: order.amountMinor.toString(),
    payments: order.payments.map((payment) => ({ ...payment, amountMinor: payment.amountMinor.toString() })),
  };
}

const withPaymentsNewestFirst = {
  payments: { orderBy: { createdAt: 'desc' as const } },
  tickets: true,
};

/**
 * One interactive transaction, same reasoning as
 * reservation.repository.ts's createReservationWithItems: the second
 * statement (creating the Payment) needs the first's generated
 * `order.id`, and everything here must commit or roll back together --
 * there is no world where an Order exists with zero Payment rows, and
 * no world where the reservation flips to PENDING_PAYMENT for an order
 * that never actually got created.
 *
 * Returns `{ ok: false }` (never throws its own error) when the
 * reservation isn't currently RESERVED -- the exact same
 * "updateMany-with-a-status-WHERE-clause as the atomicity boundary"
 * pattern releaseReservation uses (Phase 9): this call is what closes
 * the TOCTOU gap between order.service.ts's own pre-check and this
 * write actually happening, e.g. the reservation expiring in the
 * instant between the two.
 */
export async function createOrderWithFirstPayment(
  userId: string,
  reservationId: string,
  amountMinor: bigint,
  currency: string,
  provider: string,
): Promise<{ ok: true; orderId: string; paymentId: string } | { ok: false }> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    // `expiresAt > now` in the WHERE clause, not just the service's
    // pre-check: a hold that expired a moment ago but hasn't been swept
    // yet must not be checked out. On success the hold's deadline is
    // EXTENDED to the checkout timeout -- from here on the same
    // (status, expiresAt) sweep that expires holds also expires abandoned
    // checkouts (packages/database's releaseReservation).
    const updated = await tx.reservation.updateMany({
      where: { id: reservationId, status: 'RESERVED', expiresAt: { gt: now } },
      data: {
        status: 'PENDING_PAYMENT',
        expiresAt: new Date(now.getTime() + CHECKOUT_TIMEOUT_SECONDS * 1000),
      },
    });
    if (updated.count === 0) {
      return { ok: false };
    }

    const order = await tx.order.create({ data: { userId, reservationId, amountMinor, currency } });
    const payment = await tx.payment.create({
      data: { orderId: order.id, provider, amountMinor, currency },
    });

    await writeOutboxEvent(tx, {
      aggregateType: 'order',
      aggregateId: order.id,
      eventType: 'order.created',
      payload: { orderId: order.id, userId, reservationId, amountMinor: amountMinor.toString(), currency },
    });

    return { ok: true, orderId: order.id, paymentId: payment.id };
  });
}

export function setPaymentProviderRef(paymentId: string, providerRef: string): Promise<Payment> {
  return prisma.payment.update({ where: { id: paymentId }, data: { providerRef } });
}

export function findOrderById(id: string): Promise<OrderWithPayments | null> {
  return prisma.order.findUnique({ where: { id }, include: withPaymentsNewestFirst });
}

export function listOrdersForUser(userId: string): Promise<OrderWithPayments[]> {
  return prisma.order.findMany({
    where: { userId },
    include: withPaymentsNewestFirst,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Everything `handlePaymentWebhook` needs about a payment attempt in one
 * query -- the payment itself, its order, and (for the success path) the
 * reservation's currently-ACTIVE seat ids, since a successful payment
 * needs to flip every one of those seats to SOLD.
 */
// `satisfies Prisma.PaymentInclude` + `Prisma.PaymentGetPayload`, not
// `ReturnType<typeof findPaymentByProviderRefWithContext>` -- inferring
// a deeply-nested include's shape through Prisma's fluent promise type
// (`Prisma__PaymentClient`) doesn't reliably widen through `Awaited<>`,
// which silently produced the flat Payment type (no `order` at all) the
// functions below actually need. Declaring the include as its own typed
// constant and building the payload type from THAT is the robust,
// Prisma-recommended way to type a query's result shape.
const paymentWithContextInclude = {
  order: {
    include: {
      reservation: {
        include: {
          // `id`, not just `seatId` -- Phase 14's ticket issuance needs
          // the ReservationItem's OWN id (`Ticket.reservationItemId`
          // references it directly), which the seat id alone can't
          // provide.
          items: { where: { status: 'ACTIVE' as const }, select: { id: true, seatId: true } },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentWithContext = Prisma.PaymentGetPayload<{ include: typeof paymentWithContextInclude }>;

export function findPaymentByProviderRefWithContext(providerRef: string): Promise<PaymentWithContext | null> {
  return prisma.payment.findUnique({ where: { providerRef }, include: paymentWithContextInclude });
}

/**
 * Why a successful charge could NOT be applied to its order, and was
 * turned into a refund instead:
 *  - `duplicate_payment`: a different attempt already paid the order
 *    (both charges genuinely went through at the provider).
 *  - `order_not_payable`: the order was cancelled first (user cancel or
 *    CHECKOUT_TIMEOUT_SECONDS elapsed) and its seats may already belong
 *    to someone else.
 */
export type RefundReason = 'duplicate_payment' | 'order_not_payable';

export interface ApplyPaymentOutcomeResult {
  /** False when this payment was already resolved by an earlier delivery
   * -- a normal outcome under at-least-once webhook delivery. */
  applied: boolean;
  /** Set when this payment succeeded at the provider but could not pay
   * its order; the payment is now REFUND_PENDING and apps/worker's refund
   * processor returns the money. */
  refundReason?: RefundReason;
}

/**
 * Takes the reservation row lock FIRST (packages/database's
 * lockReservation -- the one lock order every lifecycle transaction
 * shares), then re-reads payment and order state under that lock. That
 * is what makes "the expiry sweeper cancels the checkout" and "the
 * provider confirms the payment" safe to race: exactly one of them runs
 * first, and this function reacts to whatever it finds:
 *
 *  - order still PENDING -> the happy path: order PAID, reservation
 *    CONFIRMED, seats SOLD, tickets issued, all in this one transaction.
 *  - order already PAID or CANCELLED -> the money is real but there is
 *    nothing left to sell it for: the payment becomes REFUND_PENDING (a
 *    durable refund intent the worker executes), never a silently
 *    dropped charge.
 */
export async function applyPaymentSucceeded(payment: PaymentWithContext): Promise<ApplyPaymentOutcomeResult> {
  return prisma.$transaction(async (tx) => {
    await lockReservation(tx, payment.order.reservationId);

    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } });
    if (current.status !== 'PENDING') {
      return { applied: false };
    }

    const order = await tx.order.findUniqueOrThrow({ where: { id: payment.order.id }, select: { status: true } });
    if (order.status !== 'PENDING') {
      const refundReason: RefundReason = order.status === 'PAID' ? 'duplicate_payment' : 'order_not_payable';
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });
      await writeOutboxEvent(tx, {
        aggregateType: 'order',
        aggregateId: payment.order.id,
        eventType: 'payment.refund_requested',
        payload: {
          orderId: payment.order.id,
          paymentId: payment.id,
          userId: payment.order.userId,
          reason: refundReason,
        },
      });
      return { applied: true, refundReason };
    }

    await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } });
    await tx.order.update({ where: { id: payment.order.id }, data: { status: 'PAID' } });
    await tx.reservation.updateMany({
      where: { id: payment.order.reservationId, status: 'PENDING_PAYMENT' },
      data: { status: 'CONFIRMED' },
    });
    const items = payment.order.reservation.items;
    const seatIds = items.map((item) => item.seatId);
    await tx.seat.updateMany({
      where: { id: { in: seatIds }, status: 'RESERVED' },
      data: { status: 'SOLD' },
    });

    // Same transaction, same all-or-nothing guarantee as every write
    // above (Phase 14): a PAID order with zero tickets, or a ticket for
    // a payment that ultimately rolled back, are both states this
    // codebase treats as impossible by construction, not just unlikely.
    await issueTicketsForOrder(
      tx,
      { id: payment.order.id, userId: payment.order.userId, eventId: payment.order.reservation.eventId },
      items,
    );

    await writeOutboxEvent(tx, {
      aggregateType: 'order',
      aggregateId: payment.order.id,
      eventType: 'order.paid',
      payload: {
        orderId: payment.order.id,
        paymentId: payment.id,
        userId: payment.order.userId,
        reservationId: payment.order.reservationId,
        eventId: payment.order.reservation.eventId,
        seatIds,
        // The ORDER's amount/currency, not the triggering Payment's --
        // Payment can be a retry attempt (createRetryPayment), while
        // Order.amountMinor is the one authoritative total Phase 16's
        // analytics consumer rolls revenue up against. bigint -> string,
        // same SerializedEvent-style wire convention as every other
        // outbox payload carrying money (docs/payment-flow.md).
        amountMinor: payment.order.amountMinor.toString(),
        currency: payment.order.currency,
      },
    });

    return { applied: true };
  });
}

export async function applyPaymentFailed(payment: PaymentWithContext): Promise<ApplyPaymentOutcomeResult> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    if (updated.count === 0) {
      return { applied: false };
    }

    await writeOutboxEvent(tx, {
      aggregateType: 'order',
      aggregateId: payment.order.id,
      eventType: 'payment.failed',
      payload: { orderId: payment.order.id, paymentId: payment.id, userId: payment.order.userId },
    });

    return { applied: true };
  });
}

/**
 * A new PENDING payment attempt -- but only if, under the reservation
 * lock, the order is still PENDING and its latest attempt FAILED. Doing
 * this check inside the transaction (not just in the service's
 * pre-check) closes the race with the expiry sweeper cancelling the
 * checkout in between: a retry must never start a fresh charge against an
 * order that was just cancelled.
 */
export async function createRetryPayment(
  order: Pick<Order, 'id' | 'reservationId' | 'amountMinor' | 'currency'>,
  provider: string,
): Promise<Payment | null> {
  return prisma.$transaction(async (tx) => {
    await lockReservation(tx, order.reservationId);

    const current = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    });
    if (current.status !== 'PENDING' || current.payments[0]?.status !== 'FAILED') {
      return null;
    }

    return tx.payment.create({
      data: { orderId: order.id, provider, amountMinor: order.amountMinor, currency: order.currency },
    });
  });
}

export interface CancelPaidOrderResult {
  cancelled: boolean;
  seatIds: string[];
  ticketCount: number;
}

/**
 * Cancels a PAID order and refunds it -- the refund/ticket-cancellation
 * flow Phases 13/14 deferred. One transaction, under the same reservation
 * lock as every other lifecycle change:
 *
 *  - order PAID -> REFUNDED
 *  - the SUCCEEDED payment -> REFUND_PENDING (apps/worker's refund
 *    processor calls the provider and flips it to REFUNDED)
 *  - every ISSUED ticket -> CANCELLED (the partial unique index on
 *    tickets is scoped to ISSUED, so the seat can be re-ticketed for a
 *    future buyer)
 *  - reservation CONFIRMED -> CANCELLED, items RELEASED, seats SOLD ->
 *    AVAILABLE (back on sale immediately)
 *  - one `order.refunded` outbox event (notifications, analytics revenue
 *    reversal, live seat maps)
 */
export async function cancelPaidOrder(orderId: string, reservationId: string): Promise<CancelPaidOrderResult> {
  return prisma.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, reservationId);

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!reservation || order.status !== 'PAID') {
      return { cancelled: false, seatIds: [], ticketCount: 0 };
    }

    await tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
    await tx.payment.updateMany({
      where: { orderId, status: 'SUCCEEDED' },
      data: { status: 'REFUND_PENDING' },
    });
    const tickets = await tx.ticket.updateMany({
      where: { orderId, status: 'ISSUED' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await tx.reservation.update({ where: { id: reservationId }, data: { status: 'CANCELLED' } });
    const items = await tx.reservationItem.findMany({
      where: { reservationId, status: 'ACTIVE' },
      select: { seatId: true },
    });
    const seatIds = items.map((item) => item.seatId);
    await tx.reservationItem.updateMany({
      where: { reservationId, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    await tx.seat.updateMany({
      where: { id: { in: seatIds }, status: 'SOLD' },
      data: { status: 'AVAILABLE' },
    });

    await writeOutboxEvent(tx, {
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'order.refunded',
      payload: {
        orderId,
        userId: order.userId,
        reservationId,
        eventId: reservation.event_id,
        seatIds,
        amountMinor: order.amountMinor.toString(),
        currency: order.currency,
      },
    });

    return { cancelled: true, seatIds, ticketCount: tickets.count };
  });
}
