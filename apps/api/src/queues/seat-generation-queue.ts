import { createBullMQConnection } from '@flashsale/redis';
import {
  QUEUE_JOB_RETENTION_COUNT,
  QUEUE_NAMES,
  SEAT_GENERATION_JOB_BACKOFF_DELAY_MS,
  SEAT_GENERATION_JOB_MAX_ATTEMPTS,
  type GenerateSeatsJobData,
} from '@flashsale/shared';
import { Queue } from 'bullmq';

import { env } from '../env.js';

/**
 * Same pattern as src/queues/email-queue.ts: the API only enqueues,
 * apps/worker's seat-generation-worker.ts is what actually runs the
 * bulk insert. See that file for why this queue exists at all.
 *
 * `defaultJobOptions` (Phase 12): fewer attempts than emailQueue's (3,
 * not 5) and a longer initial backoff -- a bulk insert failure is more
 * likely a real database problem than the transient blip a third-party
 * email API might have, so retrying aggressively is less likely to help
 * and more likely to just hammer an already-struggling database. Safe to
 * retry at all only because seat-generation-worker.ts's `skipDuplicates`
 * makes a retried job idempotent (its own comment covers why).
 */
export const seatGenerationQueue = new Queue<GenerateSeatsJobData>(QUEUE_NAMES.SEAT_GENERATION, {
  connection: createBullMQConnection(env.REDIS_URL),
  defaultJobOptions: {
    attempts: SEAT_GENERATION_JOB_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: SEAT_GENERATION_JOB_BACKOFF_DELAY_MS },
    removeOnComplete: { count: QUEUE_JOB_RETENTION_COUNT },
    removeOnFail: { count: QUEUE_JOB_RETENTION_COUNT },
  },
});
