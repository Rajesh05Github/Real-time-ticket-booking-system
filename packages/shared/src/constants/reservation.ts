/**
 * Cross-cutting reservation constants.
 *
 * These live in @flashsale/shared (not buried in apps/api) because both the
 * API (enforces the cap) and the web app (disables the "add seat" button at
 * the same number) need the SAME value. A magic `6` duplicated in two repos
 * is exactly the "magic strings" anti-pattern section 51 calls out.
 */

/**
 * Upper bound on seats per single reservation.
 *
 * Two independent reasons, not one:
 *  1. Anti-scalper control -- caps how much inventory one request can lock.
 *  2. Bounds the number of Redis locks acquired atomically per request
 *     (see docs/reservation-flow.md) and the number of rows locked in the
 *     single `SELECT ... FOR UPDATE NOWAIT` -- keeps worst-case contention
 *     and transaction size predictable under load.
 */
export const MAX_SEATS_PER_RESERVATION = 6;

/** How long a claimed-but-unpaid reservation holds its seats before expiry. */
export const RESERVATION_HOLD_SECONDS = 600;

/** Redis lock TTL during the claim step ONLY -- not the hold. See docs/redis.md. */
export const SEAT_LOCK_TTL_SECONDS = 10;

/**
 * How often apps/worker's expiry sweeper checks for overdue reservations
 * (docs/reservation-flow.md, Phase 9). Deliberately just a plain interval,
 * not a BullMQ delayed job racing it -- that's Phase 12's addition
 * (packages/shared/src/queues/queue-names.ts); this alone is already
 * fully correct, just not instantaneous (a hold can outlive its
 * `expiresAt` by up to this long before the sweeper catches it).
 */
export const RESERVATION_SWEEP_INTERVAL_MS = 30_000;

/**
 * Caps how many overdue reservations one sweep tick processes. Without
 * this, a worker that's been offline for a while (or a burst of
 * simultaneously-expiring holds during a flash sale) could turn one tick
 * into an unbounded, slow transaction storm. Left-over overdue
 * reservations are simply picked up by the NEXT tick, RESERVATION_SWEEP_
 * INTERVAL_MS later -- see the sweeper's own log line for how to notice
 * if the backlog isn't draining.
 */
export const RESERVATION_SWEEP_BATCH_SIZE = 100;
