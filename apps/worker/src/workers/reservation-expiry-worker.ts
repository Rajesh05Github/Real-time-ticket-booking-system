import { releaseReservation } from '@flashsale/database';
import { createBullMQConnection, type Redis } from '@flashsale/redis';
import { JOB_NAMES, QUEUE_NAMES, type ExpireReservationJobData } from '@flashsale/shared';
import { Worker, type Job } from 'bullmq';

import type { Logger } from '@flashsale/logger';

/**
 * The delayed-job half of Phase 9/12's expiry design -- races the
 * Postgres sweeper (reservation-expiry-sweep.ts) for near-instant
 * expiry. Calls the EXACT SAME `releaseReservation` (packages/database)
 * the sweeper and the cancel endpoint both use, so there is exactly one
 * place that decides what "releasing a reservation" does.
 *
 * Safe to be one of three simultaneous callers (this worker, the
 * sweeper, a user cancelling) because `releaseReservation`'s own `WHERE
 * status = 'RESERVED'` guard is the actual race-safety mechanism, not
 * anything in this file: whichever caller's UPDATE lands first wins,
 * the other two silently no-op (`released: false`). This job doesn't
 * even bother checking the result -- a no-op means someone else already
 * handled it, which is a completely unremarkable, expected outcome, not
 * a failure worth logging.
 */
export function startReservationExpiryWorker(redisUrl: string, logger: Logger, concurrency: number): Worker<ExpireReservationJobData> {
  const connection: Redis = createBullMQConnection(redisUrl);

  const worker = new Worker<ExpireReservationJobData>(
    QUEUE_NAMES.RESERVATION_EXPIRY,
    async (job: Job<ExpireReservationJobData>) => {
      if (job.name !== JOB_NAMES.EXPIRE_RESERVATION) {
        throw new Error(`reservation-expiry-worker received unknown job name: ${job.name}`);
      }

      const { released } = await releaseReservation(job.data.reservationId, 'EXPIRED');
      if (released) {
        logger.info({ jobId: job.id, reservationId: job.data.reservationId }, 'reservation expired via delayed job');
      }
    },
    {
      connection,
      concurrency,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, reservationId: job?.data.reservationId, attempt: job?.attemptsMade, err },
      'reservation expiry job failed',
    );
  });

  return worker;
}
