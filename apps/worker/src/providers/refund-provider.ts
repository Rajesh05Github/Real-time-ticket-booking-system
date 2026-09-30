import { randomUUID } from 'node:crypto';

/**
 * Provider abstraction for refunds -- the worker-side counterpart to
 * apps/api's PaymentProvider (charges start in the checkout REQUEST; a
 * refund is naturally background work, like sending email, so it lives
 * here). A real gateway implementation (Stripe `refunds.create`, Razorpay
 * `payments.refund`, ...) implements this once; nothing in the refund
 * processor changes.
 */
export interface RefundInput {
  /** Our Payment id -- passed to the gateway as its idempotency key, so a
   * processor that crashes after the gateway accepted the refund (but
   * before we recorded it) retries into the SAME refund, never a second. */
  paymentId: string;
  /** The gateway's reference for the original charge. */
  providerRef: string;
  amountMinor: bigint;
  currency: string;
}

export interface RefundResult {
  refundProviderRef: string;
}

export interface RefundProvider {
  refund(input: RefundInput): Promise<RefundResult>;
}

/**
 * Pairs with apps/api's MockPaymentProvider: every "charge" that mock
 * took is refundable here. Deterministic per payment (idempotent, like a
 * real gateway honoring an idempotency key).
 */
export class MockRefundProvider implements RefundProvider {
  private readonly refunds = new Map<string, string>();

  refund(input: RefundInput): Promise<RefundResult> {
    let ref = this.refunds.get(input.paymentId);
    if (!ref) {
      ref = `mock_refund_${randomUUID()}`;
      this.refunds.set(input.paymentId, ref);
    }
    return Promise.resolve({ refundProviderRef: ref });
  }
}

/**
 * Routes each refund to the gateway that took the original payment
 * (`Payment.provider`). An unknown provider throws -- the payment stays
 * REFUND_PENDING and is logged on every tick until someone wires it up,
 * rather than being silently marked refunded.
 */
export class RefundProviderRegistry {
  constructor(private readonly providers: Record<string, RefundProvider>) {}

  forProvider(name: string): RefundProvider {
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`no refund provider registered for payment provider "${name}"`);
    }
    return provider;
  }
}
