import { findRefundPendingPayments, markPaymentRefunded } from '@flashsale/database';
import { REFUND_PROCESS_BATCH_SIZE, REFUND_PROCESS_INTERVAL_MS } from '@flashsale/shared';

import { startPeriodicJob, type PeriodicJob } from './periodic-job.js';

import type { RefundProviderRegistry } from '../providers/refund-provider.js';
import type { Logger } from '@flashsale/logger';

export type RefundProcessor = PeriodicJob;

/**
 * Executes the durable refund intents apps/api records (Payment status
 * REFUND_PENDING) -- written in the same transaction as the decision that
 * requires a refund (a cancelled paid order, a success that arrived after
 * its checkout was cancelled, a genuine double payment). Because the
 * intent is committed BEFORE any external call, a crash anywhere in this
 * loop just means the next tick retries it; the provider call is keyed on
 * the payment id so a retry can't refund twice.
 *
 * One failure never blocks the rest of the batch; a payment that keeps
 * failing is logged on every tick (visible, not silently stuck).
 */
export function startRefundProcessor(registry: RefundProviderRegistry, logger: Logger): RefundProcessor {
  async function tick(): Promise<void> {
    try {
      const pending = await findRefundPendingPayments(REFUND_PROCESS_BATCH_SIZE);
      for (const payment of pending) {
        try {
          if (!payment.providerRef) {
            throw new Error('payment has no providerRef -- cannot identify the charge to refund');
          }
          const { refundProviderRef } = await registry.forProvider(payment.provider).refund({
            paymentId: payment.id,
            providerRef: payment.providerRef,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
          });
          const recorded = await markPaymentRefunded(payment, refundProviderRef);
          if (recorded) {
            logger.info({ paymentId: payment.id, orderId: payment.orderId, refundProviderRef }, 'payment refunded');
          }
        } catch (err) {
          logger.error({ err, paymentId: payment.id, orderId: payment.orderId }, 'refund attempt failed -- will retry');
        }
      }
    } catch (err) {
      logger.error({ err }, 'refund processor tick failed');
    }
  }

  return startPeriodicJob(REFUND_PROCESS_INTERVAL_MS, tick);
}
