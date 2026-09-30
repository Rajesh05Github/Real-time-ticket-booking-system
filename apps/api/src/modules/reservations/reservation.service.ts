import { Prisma, recordAuditLog, releaseReservation } from '@flashsale/database';
import { redisKeys, type Redis } from '@flashsale/redis';
import {
  DomainBadRequestError,
  DomainConflictError,
  ForbiddenError,
  JOB_NAMES,
  NotFoundError,
  RESERVATION_HOLD_SECONDS,
  SEAT_LOCK_TTL_SECONDS,
} from '@flashsale/shared';

import { reservationExpiryQueue } from '../../queues/reservation-expiry-queue.js';
import * as eventRepository from '../events/event.repository.js';
import * as seatRepository from '../seats/seat.repository.js';

import * as reservationRepository from './reservation.repository.js';

import type { ReservationWithItems } from './reservation.repository.js';

const SEAT_NOT_AVAILABLE_MESSAGE =
  'One or more of the selected seats are no longer available. Please choose different seats.';

/**
 * Acquires the admission-control lock for every requested seat, in a
 * fixed (sorted) order. Sorting matters even though `SET NX` never
 * blocks -- it makes lock ACQUISITION deterministic across concurrent
 * requests that overlap on some but not all seats, which is what keeps
 * the failure mode here "one request loses cleanly" rather than
 * something order-dependent and harder to reason about.
 *
 * Fails OPEN per-seat: a Redis error is treated as "lock acquired" (the
 * value pushed onto the returned array is skipped, not faked), because
 * this lock is admission control, not the correctness boundary -- see
 * packages/redis/src/keys.ts's seatLock entry. Returns the list of keys
 * this call actually set in Redis, so the caller releases exactly those
 * and no others.
 *
 * Self-cleaning on failure: if seat 3 of 5 loses the lock race, seats 1
 * and 2's locks -- already acquired earlier in this same loop -- are
 * released here, before throwing, rather than left to whoever called
 * this. Without that, a partial-acquisition failure would leak locks
 * that only clean up via their own TTL (up to SEAT_LOCK_TTL_SECONDS
 * later) instead of immediately, needlessly blocking a DIFFERENT
 * request for the SAME seats from proceeding straight to Postgres.
 */
async function acquireSeatLocks(redis: Redis, seatIds: string[]): Promise<string[]> {
  const acquired: string[] = [];
  const sortedSeatIds = [...seatIds].sort();

  try {
    for (const seatId of sortedSeatIds) {
      const lockKey = redisKeys.seatLock(seatId);
      let result: string | null;
      try {
        result = await redis.set(lockKey, '1', 'EX', SEAT_LOCK_TTL_SECONDS, 'NX');
      } catch {
        continue; // fail open: Redis unreachable, skip locking this seat
      }

      if (result === null) {
        // Someone else already holds this seat's admission-control lock --
        // fail fast here rather than let this request waste a Postgres
        // transaction that the unique index would reject anyway.
        throw new DomainConflictError('SEAT_NOT_AVAILABLE', SEAT_NOT_AVAILABLE_MESSAGE);
      }
      acquired.push(lockKey);
    }
    return acquired;
  } catch (err) {
    await releaseSeatLocks(redis, acquired);
    throw err;
  }
}

async function releaseSeatLocks(redis: Redis, lockKeys: string[]): Promise<void> {
  await Promise.all(lockKeys.map((key) => redis.del(key).catch(() => undefined)));
}

/**
 * The full claim flow (section 59 / docs/reservation-flow.md):
 *
 *  1. Validate the request shape and that the event/seats actually exist
 *     and belong to each other (a real 404, not a race -- existence
 *     doesn't change under concurrency the way availability does).
 *  2. Acquire per-seat Redis locks as admission control (reduces wasted
 *     Postgres transactions under contention; never the correctness
 *     boundary).
 *  3. One transaction creates the Reservation + ACTIVE ReservationItems
 *     and flips the seats to RESERVED. If the partial unique index
 *     rejects any seat (Prisma P2002), the whole transaction rolls back
 *     and this throws SEAT_NOT_AVAILABLE -- THIS is what actually
 *     prevents double-booking, independent of step 2 ever having run.
 *
 * Callers reach this from `POST /reservations`, which additionally
 * requires an Idempotency-Key (apps/api/src/plugins/idempotency.ts) --
 * that's a separate concern (protecting against a client's own retried
 * click), enforced at the route/preHandler layer, not duplicated here.
 */
export async function createReservation(
  redis: Redis,
  userId: string,
  eventId: string,
  seatIds: string[],
): Promise<ReservationWithItems> {
  if (new Set(seatIds).size !== seatIds.length) {
    throw new DomainBadRequestError('DUPLICATE_SEAT_IDS', 'The same seat was requested more than once.');
  }

  const event = await eventRepository.findEventById(eventId);
  if (!event || event.status !== 'PUBLISHED') {
    // Same visibility rule as getEventForViewer: a draft/unpublished
    // event's existence isn't confirmed to a caller who can't see it.
    throw new NotFoundError('Event');
  }

  const seats = await seatRepository.findSeatsByIds(eventId, seatIds);
  if (seats.length !== seatIds.length) {
    throw new NotFoundError('Seat');
  }

  const acquiredLocks = await acquireSeatLocks(redis, seatIds);
  try {
    const expiresAt = new Date(Date.now() + RESERVATION_HOLD_SECONDS * 1000);

    try {
      const reservation = await reservationRepository.createReservationWithItems(
        userId,
        eventId,
        seatIds,
        expiresAt,
      );

      await recordAuditLog({
        actorId: userId,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservation.id,
        metadata: { eventId, seatIds },
      });

      // Best-effort, fail-open: this is purely a LATENCY optimization
      // racing apps/worker's Postgres sweeper (Phase 9), never a
      // correctness requirement -- the sweeper alone is fully authoritative
      // (docs/reservation-flow.md). A Redis/BullMQ hiccup here must never
      // fail an otherwise-successful claim; the sweeper still expires this
      // reservation on schedule regardless, just up to
      // RESERVATION_SWEEP_INTERVAL_MS slower than the happy path.
      await reservationExpiryQueue
        .add(
          JOB_NAMES.EXPIRE_RESERVATION,
          { reservationId: reservation.id },
          { delay: RESERVATION_HOLD_SECONDS * 1000 },
        )
        .catch(() => undefined);

      return reservation;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DomainConflictError('SEAT_NOT_AVAILABLE', SEAT_NOT_AVAILABLE_MESSAGE);
      }
      throw err;
    }
  } finally {
    await releaseSeatLocks(redis, acquiredLocks);
  }
}

export async function getReservationForUser(
  reservationId: string,
  userId: string,
  userRole: string,
): Promise<ReservationWithItems> {
  const reservation = await reservationRepository.findReservationById(reservationId);
  if (!reservation) {
    throw new NotFoundError('Reservation');
  }
  if (reservation.userId !== userId && userRole !== 'ADMIN') {
    // 403, not 404: unlike a draft event, a reservation id isn't secret
    // just by existing -- the thing being protected is the DATA
    // (whose seats, whose hold), not whether the id is valid at all.
    throw new ForbiddenError('You do not have access to this reservation.');
  }
  return reservation;
}

export function listMyReservations(userId: string): Promise<ReservationWithItems[]> {
  return reservationRepository.listReservationsForUser(userId);
}

/**
 * User-initiated early release of their own hold. Reuses the EXACT same
 * `releaseReservation` transaction the expiry sweeper (apps/worker) runs
 * -- see packages/database/src/reservations.ts's comment on why that
 * function lives there instead of being duplicated per-caller.
 *
 * Works for a plain hold (RESERVED) and for a checkout in progress
 * (PENDING_PAYMENT) -- the latter also cancels the pending order, and a
 * charge that later succeeds anyway is refunded automatically (see
 * packages/database's releaseReservation). A CONFIRMED (paid) booking is
 * cancelled through `POST /orders/:orderId/cancel` instead, since it
 * involves a refund and ticket cancellation.
 *
 * The pre-check below (fetch, verify ownership/status) exists purely for
 * an accurate error message -- "already CONFIRMED" vs "already expired"
 * vs "not yours" -- and is deliberately NOT the race-safety mechanism:
 * `releaseReservation` re-checks status under a row lock, which is what
 * actually closes the TOCTOU gap between this check and the update (e.g.
 * the sweeper expiring the same reservation in the same instant this
 * request is being handled).
 */
export async function cancelReservation(reservationId: string, userId: string): Promise<void> {
  const reservation = await reservationRepository.findReservationById(reservationId);
  if (!reservation) {
    throw new NotFoundError('Reservation');
  }
  if (reservation.userId !== userId) {
    throw new ForbiddenError('You do not have access to this reservation.');
  }
  if (reservation.status !== 'RESERVED' && reservation.status !== 'PENDING_PAYMENT') {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot cancel a reservation with status ${reservation.status}.`,
    );
  }

  const result = await releaseReservation(reservationId, 'CANCELLED');
  if (!result.released) {
    // Lost a genuine race (e.g. the sweeper expired it a moment after the
    // check above) -- rare enough that a generic conflict is the right
    // level of detail; the client's next GET will show the real status.
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      'This reservation was already resolved by another process.',
    );
  }

  await recordAuditLog({
    actorId: userId,
    action: 'reservation.cancelled',
    entityType: 'reservation',
    entityId: reservationId,
    metadata: {
      seatIds: result.seatIds,
      ...(result.cancelledOrderId !== undefined ? { cancelledOrderId: result.cancelledOrderId } : {}),
    },
  });
}
