import { findExpiredReservationIds, releaseReservation } from '@flashsale/database';
import { RESERVATION_SWEEP_BATCH_SIZE, RESERVATION_SWEEP_INTERVAL_MS } from '@flashsale/shared';

import type { Logger } from '@flashsale/logger';

export interface ReservationExpirySweeper {
  /**
   * Async, and awaits any IN-FLIGHT tick before resolving -- not just
   * `clearInterval`. The exact class of bug register-shutdown-hooks.ts
   * documents for the BullMQ workers applies here too: if a tick is
   * mid-`releaseReservation` (a live Prisma call) when SIGTERM arrives,
   * stopping only the timer would let Prisma disconnect while that call
   * is still in flight. Awaiting this closes that gap.
   */
  stop: () => Promise<void>;
}

/**
 * The Postgres-column-driven half of Phase 9's expiry design
 * (docs/reservation-flow.md): every RESERVATION_SWEEP_INTERVAL_MS,
 * expire whatever's overdue. Deliberately a plain `setInterval`, not a
 * BullMQ repeatable job -- there's no per-item payload or retry/backoff
 * need here (a failed tick just tries again at the next interval), so
 * pulling in a queue for it would be exactly the unneeded machinery
 * section 58 warns against. Phase 12 adds a BullMQ delayed job PER
 * reservation as a faster complement to this sweeper, not a replacement
 * for it -- see queue-names.ts and the Reservation model's own comment
 * on why the sweeper alone must stay fully correct on its own.
 *
 * Each overdue reservation is released via the SAME `releaseReservation`
 * transaction apps/api's cancel endpoint uses (packages/database), so
 * there is exactly one place that ever decides what "releasing a
 * reservation" actually does to its items and seats.
 */
export function startReservationExpirySweeper(logger: Logger): ReservationExpirySweeper {
  // Tracks the CURRENTLY RUNNING tick's promise (not just a boolean) so
  // `stop()` has something to await -- a plain "is a tick running" flag
  // could tell shutdown that a tick is in flight, but couldn't let it
  // wait for that specific tick to actually finish.
  let currentTick: Promise<void> | null = null;
  let stopped = false;

  async function runSweep(): Promise<void> {
    try {
      const overdue = await findExpiredReservationIds(RESERVATION_SWEEP_BATCH_SIZE);
      let expiredCount = 0;

      for (const { id } of overdue) {
        try {
          const result = await releaseReservation(id, 'EXPIRED');
          if (result.released) {
            expiredCount += 1;
          }
        } catch (err) {
          logger.error({ err, reservationId: id }, 'failed to expire reservation');
        }
      }

      if (expiredCount > 0) {
        logger.info({ expiredCount, scanned: overdue.length }, 'reservation expiry sweep completed');
      }
      if (overdue.length === RESERVATION_SWEEP_BATCH_SIZE) {
        logger.warn(
          { batchSize: RESERVATION_SWEEP_BATCH_SIZE },
          'reservation expiry sweep hit its batch size limit -- there may be a backlog, will continue on the next tick',
        );
      }
    } catch (err) {
      logger.error({ err }, 'reservation expiry sweep tick failed');
    }
  }

  function fireTick(): void {
    if (currentTick || stopped) {
      // Either the previous tick is still running (an unusually large or
      // slow batch -- skip rather than overlap two sweeps racing
      // releaseReservation for the same rows) or shutdown already began.
      return;
    }
    currentTick = runSweep().finally(() => {
      currentTick = null;
    });
  }

  // Fire once immediately, not just on the first interval tick -- a
  // worker that just restarted (deploy, crash, `docker compose restart`)
  // shouldn't leave holds sitting expired-but-unswept for up to a full
  // RESERVATION_SWEEP_INTERVAL_MS before its first check ever runs.
  fireTick();
  const interval = setInterval(fireTick, RESERVATION_SWEEP_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await currentTick;
    },
  };
}
