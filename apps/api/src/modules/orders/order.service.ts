import { Prisma, recordAuditLog, releaseReservation } from '@flashsale/database';
import { DomainConflictError, ForbiddenError, NotFoundError } from '@flashsale/shared';

import * as eventRepository from '../events/event.repository.js';
import * as reservationRepository from '../reservations/reservation.repository.js';

import * as orderRepository from './order.repository.js';

import type { RefundReason, SerializedOrder } from './order.repository.js';
import type { PaymentOutcome, PaymentProvider } from '../../providers/payment-provider.js';

const ORDER_ALREADY_EXISTS_MESSAGE = 'An order already exists for this reservation.';

/**
 * The full checkout flow (section 24 / docs/payment-flow.md):
 *
 *  1. Validate ownership, that the reservation is still RESERVED (not
 *     already ordered, expired, cancelled, or itself mid-checkout), and
 *     that its hold hasn't actually expired yet (belt-and-braces --
 *     `createOrderWithFirstPayment`'s own status-guarded UPDATE is what
 *     actually closes the race; this check exists for a clean, specific
 *     error rather than a generic conflict on the common path).
 *  2. Sum the reservation's seats' prices into `amountMinor` -- computed
 *     server-side from data already trusted (the seats themselves),
 *     never accepted from the client.
 *  3. One transaction creates the Order + first Payment row and flips
 *     the reservation to PENDING_PAYMENT.
 *  4. ONLY AFTER that transaction commits does this call out to the
 *     payment provider -- never hold a database transaction open across
 *     an external call, same discipline as reservation.service.ts
 *     enqueuing its BullMQ delayed job only after its own transaction
 *     commits.
 *
 * Callers reach this from `POST /orders`, which additionally requires an
 * Idempotency-Key -- protecting against a client's own retried click, a
 * separate concern from `Order.reservationId`'s DB-level unique
 * constraint, which is what actually prevents two orders for the same
 * reservation regardless of how the duplicate request arrived.
 */
export async function createOrder(
  paymentProvider: PaymentProvider,
  userId: string,
  reservationId: string,
): Promise<SerializedOrder> {
  const reservation = await reservationRepository.findReservationById(reservationId);
  if (!reservation) {
    throw new NotFoundError('Reservation');
  }
  if (reservation.userId !== userId) {
    throw new ForbiddenError('You do not have access to this reservation.');
  }
  if (reservation.status !== 'RESERVED') {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot create an order for a reservation with status ${reservation.status}.`,
    );
  }
  if (reservation.expiresAt.getTime() <= Date.now()) {
    throw new DomainConflictError('RESERVATION_EXPIRED', 'This reservation hold has expired.');
  }

  // Trusts only the seats' own stored prices -- never a client-supplied
  // amount. All seats in one reservation are assumed to share a currency
  // (true for every seat-generation path this codebase has, section 29);
  // a venue mixing currencies within one event is out of scope.
  const amountMinor = reservation.items.reduce((sum, item) => sum + BigInt(item.seat.priceMinor), 0n);
  const currency = reservation.items[0]?.seat.currency ?? 'INR';

  let created;
  try {
    created = await orderRepository.createOrderWithFirstPayment(
      userId,
      reservationId,
      amountMinor,
      currency,
      paymentProvider.name,
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Order.reservationId's unique constraint -- the actual correctness
      // boundary, same "catch the DB constraint, translate to a domain
      // error" pattern as venue.service.ts and reservation.service.ts.
      throw new DomainConflictError('ORDER_ALREADY_EXISTS', ORDER_ALREADY_EXISTS_MESSAGE);
    }
    throw err;
  }
  if (!created.ok) {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      'This reservation is no longer available for checkout.',
    );
  }

  const { providerRef } = await paymentProvider.charge({
    orderId: created.orderId,
    paymentId: created.paymentId,
    amountMinor,
    currency,
  });
  await orderRepository.setPaymentProviderRef(created.paymentId, providerRef);

  const order = await orderRepository.findOrderById(created.orderId);
  if (!order) {
    throw new NotFoundError('Order');
  }
  return orderRepository.serializeOrder(order);
}

export async function getOrderForUser(
  orderId: string,
  userId: string,
  userRole: string,
): Promise<SerializedOrder> {
  const order = await orderRepository.findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order');
  }
  if (order.userId !== userId && userRole !== 'ADMIN') {
    throw new ForbiddenError('You do not have access to this order.');
  }
  return orderRepository.serializeOrder(order);
}

export async function listMyOrders(userId: string): Promise<SerializedOrder[]> {
  const orders = await orderRepository.listOrdersForUser(userId);
  return orders.map((order) => orderRepository.serializeOrder(order));
}


/**
 * A new Payment attempt against an EXISTING Order -- the schema's own
 * comment on the Payment model anticipates exactly this ("a failed
 * payment attempt legitimately gets retried, producing a second Payment
 * row against the same Order"). Only allowed when the order is still
 * PENDING and its most recent attempt has actually FAILED -- not while
 * one is still PENDING (that would race two live charge attempts for
 * the same order) and not once the order is already PAID/CANCELLED.
 * `createRetryPayment` re-checks both under the reservation lock; the
 * checks here exist for specific error messages on the common path.
 */
export async function retryPayment(
  paymentProvider: PaymentProvider,
  userId: string,
  orderId: string,
): Promise<SerializedOrder> {
  const order = await orderRepository.findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order');
  }
  if (order.userId !== userId) {
    throw new ForbiddenError('You do not have access to this order.');
  }
  if (order.status !== 'PENDING') {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot retry payment for an order with status ${order.status}.`,
    );
  }

  const latestPayment = order.payments[0]; // withPaymentsNewestFirst
  if (!latestPayment || latestPayment.status !== 'FAILED') {
    throw new DomainConflictError(
      'PAYMENT_RETRY_NOT_ALLOWED',
      'A new payment attempt can only be started after the previous one has failed.',
    );
  }

  const payment = await orderRepository.createRetryPayment(order, paymentProvider.name);
  if (!payment) {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      'This order is no longer awaiting payment.',
    );
  }
  const { providerRef } = await paymentProvider.charge({
    orderId,
    paymentId: payment.id,
    amountMinor: order.amountMinor,
    currency: order.currency,
  });
  await orderRepository.setPaymentProviderRef(payment.id, providerRef);

  const refreshed = await orderRepository.findOrderById(orderId);
  if (!refreshed) {
    throw new NotFoundError('Order');
  }
  return orderRepository.serializeOrder(refreshed);
}

/**
 * `POST /orders/:orderId/cancel` -- one endpoint for both halves of an
 * order's life:
 *
 *  - PENDING (checkout in progress): releases the reservation via the
 *    same `releaseReservation` transaction the sweeper uses, which also
 *    cancels the order. A charge still in flight at the provider is
 *    refunded automatically if it later succeeds.
 *  - PAID: cancels every ticket, returns the seats to sale, and queues a
 *    refund (`cancelPaidOrder`). Customers may only do this before the
 *    event starts; admins may do it at any time (e.g. event cancelled,
 *    support case).
 *
 * Owner or ADMIN only. The route adds an Idempotency-Key requirement, so
 * a double-clicked "Cancel booking" never becomes two operations.
 */
export async function cancelOrder(orderId: string, userId: string, userRole: string): Promise<SerializedOrder> {
  const order = await orderRepository.findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order');
  }
  const isAdmin = userRole === 'ADMIN';
  if (order.userId !== userId && !isAdmin) {
    throw new ForbiddenError('You do not have access to this order.');
  }

  if (order.status === 'PENDING') {
    const result = await releaseReservation(order.reservationId, 'CANCELLED');
    if (!result.released) {
      throw new DomainConflictError(
        'INVALID_STATUS_TRANSITION',
        'This order was already resolved by another process. Refresh to see its current status.',
      );
    }
    await recordAuditLog({
      actorId: userId,
      action: 'order.cancelled',
      entityType: 'order',
      entityId: orderId,
      metadata: { seatIds: result.seatIds, stage: 'checkout' },
    });
  } else if (order.status === 'PAID') {
    const reservation = await reservationRepository.findReservationById(order.reservationId);
    const event = reservation ? await eventRepository.findEventById(reservation.eventId) : null;
    if (!isAdmin && event && event.startTime.getTime() <= Date.now()) {
      throw new DomainConflictError(
        'EVENT_ALREADY_STARTED',
        'Bookings can no longer be cancelled once the event has started.',
      );
    }

    const result = await orderRepository.cancelPaidOrder(orderId, order.reservationId);
    if (!result.cancelled) {
      throw new DomainConflictError(
        'INVALID_STATUS_TRANSITION',
        'This order was already resolved by another process. Refresh to see its current status.',
      );
    }
    await recordAuditLog({
      actorId: userId,
      action: 'order.refunded',
      entityType: 'order',
      entityId: orderId,
      metadata: { seatIds: result.seatIds, ticketCount: result.ticketCount, byAdmin: isAdmin },
    });
  } else {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot cancel an order with status ${order.status}.`,
    );
  }

  const refreshed = await orderRepository.findOrderById(orderId);
  if (!refreshed) {
    throw new NotFoundError('Order');
  }
  return orderRepository.serializeOrder(refreshed);
}

export interface PaymentWebhookResult {
  /** False when this providerRef was already resolved by an earlier
   * delivery -- an expected, harmless outcome under at-least-once
   * webhook delivery, not an error. */
  processed: boolean;
  /** Set when a successful charge could not be applied (order already
   * paid by another attempt, or cancelled first) and was queued for an
   * automatic refund instead. */
  refundReason?: RefundReason;
}

/**
 * Idempotent by construction, not by a separate dedup table: looked up
 * by `providerRef` (unique per charge attempt), and both outcome
 * branches only apply their transition while the payment is still
 * PENDING (order.repository.ts). A payment already resolved short-
 * circuits here before ever reaching that guard -- this IS the ack-
 * without-reprocessing behavior a webhook handler needs under at-least-
 * once delivery (the same idea Phase 11's stream consumer applies to
 * domain events, applied here to provider webhooks instead).
 */
export async function handlePaymentWebhook(
  providerRef: string,
  outcome: PaymentOutcome,
): Promise<PaymentWebhookResult> {
  const payment = await orderRepository.findPaymentByProviderRefWithContext(providerRef);
  if (!payment) {
    throw new NotFoundError('Payment');
  }

  if (payment.status !== 'PENDING') {
    return { processed: false };
  }

  const result =
    outcome === 'succeeded'
      ? await orderRepository.applyPaymentSucceeded(payment)
      : await orderRepository.applyPaymentFailed(payment);

  return {
    processed: result.applied,
    // Conditional spread, not a direct assignment: exactOptionalPropertyTypes
    // treats "key present with value undefined" as a different shape than
    // "key omitted".
    ...(result.refundReason !== undefined ? { refundReason: result.refundReason } : {}),
  };
}
