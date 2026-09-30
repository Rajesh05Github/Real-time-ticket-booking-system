/**
 * Payment constants (Phase 13, section 23's provider-abstraction pattern
 * applied to payments instead of email).
 */

/**
 * How long MockPaymentProvider waits before "confirming" a charge via the
 * webhook path -- long enough that a live test can observe the Payment
 * sitting genuinely PENDING in between (proving the async, webhook-driven
 * design is real and not just a same-request illusion), short enough not
 * to make manual testing tedious.
 */
export const PAYMENT_MOCK_CONFIRM_DELAY_MS = 3_000;

/**
 * How long a reservation may sit in PENDING_PAYMENT (checkout started,
 * no payment outcome yet) before apps/worker's expiry sweeper gives up on
 * it: the order is CANCELLED, the reservation EXPIRED and its seats go
 * back on sale. Applied by extending Reservation.expiresAt when checkout
 * starts, so the sweeper's one (status, expiresAt) query covers both
 * holds and abandoned checkouts. A payment success that arrives AFTER
 * this timeout is refunded automatically rather than silently dropped
 * (docs/payment-flow.md).
 */
export const CHECKOUT_TIMEOUT_SECONDS = 900;

/** How often apps/worker's refund processor looks for REFUND_PENDING payments. */
export const REFUND_PROCESS_INTERVAL_MS = 10_000;

/** Max refunds one processor tick attempts -- the rest wait for the next tick. */
export const REFUND_PROCESS_BATCH_SIZE = 20;
