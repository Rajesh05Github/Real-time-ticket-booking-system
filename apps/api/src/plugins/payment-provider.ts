import fp from 'fastify-plugin';

import { handlePaymentWebhook } from '../modules/orders/order.service.js';
import { MockPaymentProvider } from '../providers/mock-payment-provider.js';

import type { PaymentProvider } from '../providers/payment-provider.js';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    paymentProvider: PaymentProvider;
  }
}

/**
 * Constructs the ONE `MockPaymentProvider` instance the whole app shares
 * and wires its simulated-webhook callback directly to
 * `handlePaymentWebhook` -- built here, not at module scope in
 * mock-payment-provider.ts itself, specifically so a failure in that
 * callback has `app.log` to report to (a plain module-level singleton,
 * like emailQueue's, would have no logger to reach for).
 *
 * This is also the resolution to what would otherwise be a circular
 * dependency: the provider needs a reference to the webhook handler,
 * and (conceptually) the webhook ROUTE needs a reference to the
 * provider. Building both here, after order.service.ts already exists
 * as a plain module with no dependency on this plugin, avoids either
 * file needing to import the other.
 */
export const paymentProviderPlugin = fp((app: FastifyInstance) => {
  const paymentProvider = new MockPaymentProvider((providerRef, outcome) => {
    handlePaymentWebhook(providerRef, outcome)
      .then((result) => {
        if (result.refundReason) {
          app.log.warn(
            { providerRef, refundReason: result.refundReason },
            'payment succeeded for an order that could not accept it -- queued for automatic refund',
          );
        }
      })
      .catch((err: unknown) => {
        app.log.error({ err, providerRef, outcome }, 'mock payment provider failed to process its own simulated webhook');
      });
  });

  app.decorate('paymentProvider', paymentProvider);
});
