import { timingSafeEqual } from 'node:crypto';

import { apiSuccess, UnauthorizedError } from '@flashsale/shared';

import { env } from '../../env.js';
import * as orderService from '../orders/order.service.js';

import { paymentWebhookSchema } from './payment.schema.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const WEBHOOK_SECRET_HEADER = 'x-payment-webhook-secret';

/**
 * Deliberately NOT `requireAuth` -- the caller here is the payment
 * provider's own servers, not a logged-in user; there is no session
 * cookie to check. A shared secret is this project's stand-in for a
 * real provider's cryptographic request signature (e.g. Stripe's
 * HMAC-signed `Stripe-Signature` header verified against the raw
 * request body) -- see env.ts's PAYMENT_WEBHOOK_SECRET for why that's
 * a deliberate simplification, not an oversight.
 *
 * `timingSafeEqual`, not `===`: a plain string comparison on a secret
 * returns as soon as the first mismatched byte is found, which leaks
 * (via response timing) how many leading characters an attacker's guess
 * got right. Constant-time comparison costs nothing here and closes
 * that side channel -- cheap enough that there's no reason to skip it
 * even on a route this low-stakes.
 *
 * `async` despite no `await` -- every preHandler in this codebase is, on
 * principle (see rbac.ts's comment on the Fastify preHandler-array hang
 * this avoids).
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function verifyWebhookSecret(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const provided = request.headers[WEBHOOK_SECRET_HEADER];
  const expected = env.PAYMENT_WEBHOOK_SECRET;

  const providedBuffer = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws if the buffers differ in length rather than
  // returning false -- checking length first (itself not a useful signal
  // to an attacker; secret length isn't the secret) avoids that throw
  // path entirely instead of wrapping this in a try/catch.
  const matches =
    providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);

  if (!matches) {
    throw new UnauthorizedError('Invalid webhook signature.');
  }
}

export function paymentRoutes(app: FastifyInstance): void {
  app.post('/webhook', { preHandler: verifyWebhookSecret }, async (request, reply) => {
    const body = paymentWebhookSchema.parse(request.body);
    const result = await orderService.handlePaymentWebhook(body.providerRef, body.outcome);

    if (result.refundReason) {
      // The charge really happened, but its order could not accept it
      // (already paid by another attempt, or cancelled/timed out first).
      // The Payment is now REFUND_PENDING and apps/worker's refund
      // processor returns the money -- see docs/payment-flow.md.
      request.log.warn(
        { providerRef: body.providerRef, refundReason: result.refundReason },
        'payment succeeded for an order that could not accept it -- queued for automatic refund',
      );
    }

    // 200 regardless of whether THIS delivery caused a state change --
    // `processed: false` means a duplicate delivery of an
    // already-resolved outcome, which is a normal, expected occurrence
    // under at-least-once webhook delivery, not an error the provider
    // should retry.
    reply.status(200).send(apiSuccess({ received: true }));
  });
}
