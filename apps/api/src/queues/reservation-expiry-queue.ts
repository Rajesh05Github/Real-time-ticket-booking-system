import { createBullMQConnection } from '@flashsale/redis';
import {
  QUEUE_JOB_RETENTION_COUNT,
  QUEUE_NAMES,
  RESERVATION_EXPIRY_JOB_BACKOFF_DELAY_MS,
  RESERVATION_EXPIRY_JOB_MAX_ATTEMPTS,
  type ExpireReservationJobData,
} from '@flashsale/shared';
import { Queue } from 'bullmq';

import { env } from '../env.js';

/**
 * Same "API only enqueues" pattern as the other two queues -- see
 * apps/worker/src/workers/reservation-expiry-worker.ts for what actually
 * processes these. reservation.service.ts's `createReservation` adds one
 * DELAYED job per successful claim (`delay: RESERVATION_HOLD_SECONDS *
 * 1000`), racing apps/worker's Postgres sweeper
 * (reservation-expiry-sweep.ts, Phase 9) for near-instant expiry instead
 * of waiting up to RESERVATION_SWEEP_INTERVAL_MS. Both ultimately call
 * the SAME `releaseReservation` (packages/database), whose `WHERE status
 * = 'RESERVED'` guard makes it harmless for whichever one loses the
 * race to be a no-op -- see docs/queues.md.
 */
export const reservationExpiryQueue = new Queue<ExpireReservationJobData>(QUEUE_NAMES.RESERVATION_EXPIRY, {
  connection: createBullMQConnection(env.REDIS_URL),
  defaultJobOptions: {
    attempts: RESERVATION_EXPIRY_JOB_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: RESERVATION_EXPIRY_JOB_BACKOFF_DELAY_MS },
    removeOnComplete: { count: QUEUE_JOB_RETENTION_COUNT },
    removeOnFail: { count: QUEUE_JOB_RETENTION_COUNT },
  },
});
