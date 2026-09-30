import { deleteExpiredIdempotencyKeys } from '@flashsale/database';
import {
  IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MS,
  IDEMPOTENCY_KEY_RETENTION_MS,
  IDEMPOTENCY_KEY_STALE_IN_PROGRESS_MS,
} from '@flashsale/shared';

import { startPeriodicJob, type PeriodicJob } from './periodic-job.js';

import type { Logger } from '@flashsale/logger';

export type IdempotencyKeyCleanup = PeriodicJob;

/**
 * Retention for apps/api's idempotency_keys table, which previously grew
 * forever (one row per reservation/order/payment-retry/cancel request).
 * See packages/database's deleteExpiredIdempotencyKeys for what each
 * deletion rule protects against.
 */
export function startIdempotencyKeyCleanup(logger: Logger): IdempotencyKeyCleanup {
  async function tick(): Promise<void> {
    try {
      const now = Date.now();
      const result = await deleteExpiredIdempotencyKeys(
        new Date(now - IDEMPOTENCY_KEY_RETENTION_MS),
        new Date(now - IDEMPOTENCY_KEY_STALE_IN_PROGRESS_MS),
      );
      if (result.completedDeleted > 0 || result.staleInProgressDeleted > 0) {
        logger.info(result, 'idempotency key cleanup completed');
      }
    } catch (err) {
      logger.error({ err }, 'idempotency key cleanup failed');
    }
  }

  return startPeriodicJob(IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MS, tick);
}
