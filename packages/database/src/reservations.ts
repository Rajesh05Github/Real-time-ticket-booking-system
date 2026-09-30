import { prisma } from './client.js';
import { writeOutboxEvent } from './outbox.js';

import type { Prisma, ReservationStatus } from '@prisma/client';

export interface LockedReservationRow {
  id: string;
  status: ReservationStatus;
  expires_at: Date;
  user_id: string;
  event_id: string;
}

/**
 * `SELECT ... FOR UPDATE` on one reservation row, inside the caller's
 * transaction. Every transaction that changes a reservation's lifecycle
 * (release/expiry, payment success, paid-order cancellation) takes THIS
 * lock FIRST, before touching orders/payments/seats. One global lock
 * order is what makes those transactions serialize cleanly instead of
 * deadlocking against each other (e.g. the expiry sweeper cancelling a
 * checkout at the same instant the payment webhook confirms it).
 */
export async function lockReservation(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<LockedReservationRow | null> {
  const rows = await tx.$queryRaw<LockedReservationRow[]>`
    SELECT id, status, expires_at, user_id, event_id
    FROM reservations
    WHERE id = ${reservationId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export interface ReleaseReservationResult {
  released: boolean;
  seatIds: string[];
  /** Set when the reservation was mid-checkout and its PENDING order was
   * cancelled as part of the release. */
  cancelledOrderId?: string;
}

/**
 * The one release-state-transition used by a user-initiated cancel
 * (apps/api), the periodic expiry sweeper and the BullMQ expiry job
 * (apps/worker) -- lives here, not in apps/api, because apps/worker has no
 * Fastify instance to hang a service module off of, but every caller
 * needs to run the EXACT same transaction.
 *
 * Handles both releasable states:
 *
 *  - RESERVED: a plain hold -- items released, seats back to AVAILABLE.
 *  - PENDING_PAYMENT: checkout started but never resolved (user cancel,
 *    or CHECKOUT_TIMEOUT_SECONDS elapsed). Additionally cancels the
 *    PENDING order. Any payment attempt still PENDING at the provider is
 *    deliberately left PENDING: if the provider later reports success,
 *    the webhook handler sees a non-payable order and turns that payment
 *    into a refund (order.repository.ts) -- real money is never dropped.
 *
 * Race safety comes from `lockReservation` (row lock, global lock order)
 * plus re-checking status/expiry AFTER acquiring the lock, so whichever of
 * cancel / sweeper / delayed job / payment webhook gets the lock first
 * wins and every other caller observes the result and no-ops.
 *
 * `finalStatus === 'EXPIRED'` additionally requires the hold to actually
 * be past `expiresAt` -- the BullMQ delayed job fires at the ORIGINAL
 * hold deadline, and must not cancel a checkout whose deadline was
 * extended when payment started.
 */
export async function releaseReservation(
  reservationId: string,
  finalStatus: Extract<ReservationStatus, 'CANCELLED' | 'EXPIRED'>,
): Promise<ReleaseReservationResult> {
  return prisma.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, reservationId);
    if (!reservation) {
      return { released: false, seatIds: [] };
    }
    if (reservation.status !== 'RESERVED' && reservation.status !== 'PENDING_PAYMENT') {
      return { released: false, seatIds: [] };
    }
    if (finalStatus === 'EXPIRED' && reservation.expires_at.getTime() > Date.now()) {
      return { released: false, seatIds: [] };
    }

    let cancelledOrderId: string | undefined;
    if (reservation.status === 'PENDING_PAYMENT') {
      const order = await tx.order.findUnique({
        where: { reservationId },
        select: { id: true, status: true },
      });
      if (order && order.status === 'PENDING') {
        await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
        cancelledOrderId = order.id;
      }
    }

    await tx.reservation.update({ where: { id: reservationId }, data: { status: finalStatus } });

    const items = await tx.reservationItem.findMany({
      where: { reservationId, status: 'ACTIVE' },
      select: { seatId: true },
    });
    const seatIds = items.map((item) => item.seatId);

    await tx.reservationItem.updateMany({
      where: { reservationId, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    // Only flips seats this reservation itself put into RESERVED -- a
    // seat already SOLD by a different, later reservation is never
    // touched by a cancel/expiry on an older one.
    await tx.seat.updateMany({
      where: { id: { in: seatIds }, status: 'RESERVED' },
      data: { status: 'AVAILABLE' },
    });

    // Same transaction, same all-or-nothing guarantee as the writes above
    // (Phase 10, section 8). `eventId` + `seatIds` let the live-seats
    // consumer push the change to every open seat map.
    await writeOutboxEvent(tx, {
      aggregateType: 'reservation',
      aggregateId: reservationId,
      eventType: finalStatus === 'CANCELLED' ? 'reservation.cancelled' : 'reservation.expired',
      payload: {
        reservationId,
        userId: reservation.user_id,
        eventId: reservation.event_id,
        seatIds,
      },
    });

    if (cancelledOrderId) {
      await writeOutboxEvent(tx, {
        aggregateType: 'order',
        aggregateId: cancelledOrderId,
        eventType: 'order.cancelled',
        payload: {
          orderId: cancelledOrderId,
          reservationId,
          userId: reservation.user_id,
          eventId: reservation.event_id,
          reason: finalStatus === 'EXPIRED' ? 'checkout_timeout' : 'user_cancelled',
        },
      });
    }

    return {
      released: true,
      seatIds,
      ...(cancelledOrderId !== undefined ? { cancelledOrderId } : {}),
    };
  });
}

/**
 * The expiry sweeper's query (schema.prisma's `@@index([status,
 * expiresAt])` on Reservation serves it). Covers both plain holds
 * (RESERVED, deadline = RESERVATION_HOLD_SECONDS) and abandoned
 * checkouts (PENDING_PAYMENT, deadline extended to
 * CHECKOUT_TIMEOUT_SECONDS when checkout started). Bounded by `limit` --
 * see apps/worker/src/jobs/reservation-expiry-sweep.ts.
 */
export function findExpiredReservationIds(limit: number): Promise<{ id: string }[]> {
  return prisma.reservation.findMany({
    where: { status: { in: ['RESERVED', 'PENDING_PAYMENT'] }, expiresAt: { lt: new Date() } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });
}
