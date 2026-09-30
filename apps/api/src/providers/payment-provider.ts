/**
 * Provider abstraction (section 23's pattern -- see
 * apps/worker/src/providers/email-provider.ts for the same idea applied
 * to email). Order/payment business logic calls this interface, never a
 * specific gateway's SDK directly. Swapping in a real provider (Stripe,
 * Razorpay, ...) later means implementing this interface once, not
 * touching every call site that currently initiates a charge.
 *
 * Lives in apps/api, not apps/worker like EmailProvider does -- a
 * deliberate difference, not an inconsistency. Sending an OTP email is
 * naturally a background job: nothing about registering needs to wait
 * for it. Initiating a charge is naturally part of the checkout REQUEST
 * itself (the client needs SOMETHING back -- a providerRef, a redirect
 * URL, an error -- before the request can even resolve); the actual
 * confirmation of whether the charge succeeded is what happens
 * asynchronously, via the webhook this same interface's caller also
 * exposes (apps/api/src/modules/payments/payment.routes.ts).
 */
export interface ChargeInput {
  orderId: string;
  paymentId: string;
  amountMinor: bigint;
  currency: string;
}

export interface ChargeResult {
  /** Opaque reference the provider uses to identify this charge attempt
   * in its own webhook deliveries -- stored on the Payment row so an
   * incoming webhook can be matched back to the attempt it's about. */
  providerRef: string;
}

export interface PaymentProvider {
  /** Stored on every Payment row (`Payment.provider`) so a refund is
   * always sent back through the gateway that took the money. */
  readonly name: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

/**
 * What a webhook delivery (real or, for now, MockPaymentProvider's
 * simulated one) ultimately reports. Lives here, not in
 * mock-payment-provider.ts, because order.service.ts's
 * `handlePaymentWebhook` needs this type regardless of which provider
 * produced it -- a real provider's webhook would report the exact same
 * two outcomes.
 */
export type PaymentOutcome = 'succeeded' | 'failed';
