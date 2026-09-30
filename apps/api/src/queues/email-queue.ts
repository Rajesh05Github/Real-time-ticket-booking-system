import { createBullMQConnection } from '@flashsale/redis';
import {
  EMAIL_JOB_BACKOFF_DELAY_MS,
  EMAIL_JOB_MAX_ATTEMPTS,
  QUEUE_JOB_RETENTION_COUNT,
  QUEUE_NAMES,
  type SendOtpEmailJobData,
} from '@flashsale/shared';
import { Queue } from 'bullmq';

import { env } from '../env.js';

/**
 * The API only ever ENQUEUES jobs -- it never processes them (that's
 * apps/worker's job, see apps/worker/src/workers/email-worker.ts). A
 * `Queue` instance is deliberately lighter-weight than a `Worker`: it
 * doesn't poll for jobs, doesn't need `concurrency`, and doesn't need the
 * `enableReadyCheck: false` reasoning to matter as much -- but it does
 * still need its own dedicated connection with `maxRetriesPerRequest:
 * null`, same as the worker's, per BullMQ's own requirements.
 *
 * `defaultJobOptions` (Phase 12): BullMQ's actual default is `attempts:
 * 1` -- no retry at all -- which is what this queue silently ran on
 * since Phase 4 despite this file's own docstring having always claimed
 * "automatic retry with backoff." Retries now really happen; `removeOnFail`
 * is bounded (not BullMQ's default of "keep forever") so the failed set
 * -- this project's dead-letter store, see docs/queues.md -- doesn't grow
 * without limit.
 */
export const emailQueue = new Queue<SendOtpEmailJobData>(QUEUE_NAMES.EMAIL, {
  connection: createBullMQConnection(env.REDIS_URL),
  defaultJobOptions: {
    attempts: EMAIL_JOB_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: EMAIL_JOB_BACKOFF_DELAY_MS },
    removeOnComplete: { count: QUEUE_JOB_RETENTION_COUNT },
    removeOnFail: { count: QUEUE_JOB_RETENTION_COUNT },
  },
});
