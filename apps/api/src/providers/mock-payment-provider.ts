import { randomUUID } from 'node:crypto';

import { PAYMENT_MOCK_CONFIRM_DELAY_MS } from '@flashsale/shared';

import type { ChargeInput, ChargeResult, PaymentOutcome, PaymentProvider } from './payment-provider.js';

/**
 * Stand-in for a real gateway -- see providers/payment-provider.ts for
 * why this interface exists at all, and console-email-provider.ts
 * (apps/worker) for the same "obviously fake, clearly labeled" local
 * dev pattern applied here to payments instead of email.
 *
 * `charge()` returns immediately with a fresh `providerRef` (a real
 * gateway's checkout API works the same way: you get a reference back
 * right away, long before you know whether the charge actually went
 * through) and separately schedules a call to `onOutcome` after
 * PAYMENT_MOCK_CONFIRM_DELAY_MS, simulating the gateway's own webhook
 * delivery. This is deliberately NOT a fake HTTP round-trip to this
 * process's own webhook route -- `onOutcome` is wired directly to
 * order.service.ts's `handlePaymentWebhook` (apps/api/src/plugins/
 * payment-provider.ts) so the mock exercises the SAME idempotent
 * processing path a real provider's webhook call would, without the
 * complexity of this process making an HTTP request to itself.
 *
 * Always resolves 'succeeded' -- this mock never manufactures a decline.
 * The failure path (Payment FAILED, Order stays PENDING, retry produces
 * a second Payment) is instead exercised by calling the REAL webhook
 * route directly with a crafted payload, exactly like Stripe's own CLI
 * (`stripe trigger payment_intent.payment_failed`) simulates provider
 * events for local testing without needing the provider to actually
 * decline anything. See docs/payment-flow.md.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(
    private readonly onOutcome: (providerRef: string, outcome: PaymentOutcome) => void,
    private readonly confirmDelayMs: number = PAYMENT_MOCK_CONFIRM_DELAY_MS,
  ) {}

  charge(_input: ChargeInput): Promise<ChargeResult> {
    const providerRef = randomUUID();

    setTimeout(() => {
      this.onOutcome(providerRef, 'succeeded');
    }, this.confirmDelayMs);

    return Promise.resolve({ providerRef });
  }
}
