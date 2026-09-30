# Payments (Phase 13)

Order creation, the provider abstraction, and idempotent webhook
handling — the piece `schema.prisma`'s `Payment` model has been
pointing at since Phase 3 ("enforcing exactly-one-SUCCEEDED-per-Order is
Phase 13's job at the application layer"). Ticket issuance from a `PAID`
order is deliberately NOT this phase — that's Phase 14, a fully separate
model and concern.

## The flow

```
POST /orders            { reservationId }         -> Order (PENDING) + first Payment (PENDING)
                                                       reservation RESERVED -> PENDING_PAYMENT
POST /payments/webhook  { providerRef, outcome }   -> Payment SUCCEEDED/FAILED
                                                       (on success) Order PAID, reservation CONFIRMED,
                                                       seats SOLD
POST /orders/:id/retry-payment                     -> a NEW Payment row against the SAME order,
                                                       only after the latest one FAILED
```

## Why order creation needs no Redis lock, unlike seat reservation

Phase 9's seat claim needed a Redis admission-control lock because many
concurrent requests can legitimately race for the SAME contended seat.
Order creation has no equivalent hot spot: `Order.reservationId` is
`@unique`, and by the time a reservation reaches `POST /orders` it's
already exclusively held by exactly one user (Phase 9's own correctness
boundary). There's nothing to admit-control — the correctness boundary
is entirely `Order.reservationId`'s DB-level uniqueness, the same
"catch the constraint, translate it to a domain error" pattern already
used for `sections`, `reservation_items`, and `idempotency_keys`. Not
every write path needs a Redis layer in front of it; only ones with
real contention do.

## The provider abstraction, and why it lives in apps/api

`PaymentProvider` (section 23 applied to payments, mirroring
`EmailProvider`) is a one-method interface: `charge(input) ->
{ providerRef }`. `MockPaymentProvider` stands in for a real gateway,
exactly like `ConsoleEmailProvider` stands in for a real email service.

It lives in **apps/api**, not apps/worker like `EmailProvider` does —
deliberately, not inconsistently. Sending an OTP is naturally a
background job; nothing about registering needs to wait for delivery.
Initiating a charge is naturally part of the checkout **request**
itself — the client needs something back (a `providerRef`, in a real
integration maybe a redirect URL) before the request can even resolve.
What happens asynchronously is the *confirmation*, which is exactly what
the webhook is for.

## Why a webhook exists at all for a mock provider

It would be simpler to have `MockPaymentProvider.charge()` just decide
success/failure synchronously and return it in the same response. That
would also be dishonest about how payment gateways actually work:
real charges are confirmed asynchronously (3D Secure, bank transfers,
fraud review), which is precisely why every real provider's integration
model centers on a webhook, and why this project's `Payment` model has
its own independent status distinct from `Order`.

`MockPaymentProvider.charge()` returns a fresh `providerRef` immediately
and schedules a call to `handlePaymentWebhook` after
`PAYMENT_MOCK_CONFIRM_DELAY_MS` (3s) — in-process, not a fake HTTP
round-trip to this server's own route. **Live-verified**: querying a
reservation's status immediately after `POST /orders` returned
`PENDING_PAYMENT`, not `CONFIRMED` — proving the async gap is real, not
a same-request illusion, before the 3-second mark passed and it flipped
on its own.

The real webhook **route** (`POST /payments/webhook`) still exists
independently and uses the exact same `handlePaymentWebhook` function.
That let live verification simulate BOTH outcomes directly — exactly
like Stripe's own CLI (`stripe trigger payment_intent.payment_failed`)
lets you simulate provider events locally without the provider itself
ever declining anything:

- Delivered a crafted `{ outcome: "failed" }` webhook before the mock's
  own success callback fired → `Payment` → `FAILED`, `Order` stayed
  `PENDING` (retryable), confirmed the mock's LATER natural success
  delivery for that same `providerRef` did **not** resurrect the
  already-FAILED payment.
- Redelivered the SAME `providerRef` with `succeeded` a second time
  (simulating at-least-once webhook redelivery) → the row stayed
  untouched at its already-COMPLETED status; no double-processing.

## Why the webhook route isn't `requireAuth`

The caller is the payment provider's servers, not a logged-in user —
there's no session cookie to check. `verifyWebhookSecret` checks a
shared-secret header instead, using `timingSafeEqual` rather than `===`
(a plain string comparison leaks, via response timing, how many leading
bytes of a guessed secret were correct — constant-time comparison costs
nothing and closes that off). `PAYMENT_WEBHOOK_SECRET` is explicitly a
LOCAL DEVELOPMENT SIMPLIFICATION for what a real integration would use
instead: a cryptographic signature over the raw request body (e.g.
Stripe's HMAC-signed `Stripe-Signature` header), which additionally
proves the payload wasn't tampered with in transit — a shared secret
alone only proves the caller knew the secret.

## The retry path: two Payment rows, one Order

`Order.reservationId` being unique means a failed payment can **never**
produce a second Order for the same reservation — the retry has to
happen against the *existing* order instead, which is exactly what the
schema comment anticipated: "a failed payment attempt legitimately gets
retried, producing a second Payment row against the same Order."
`POST /orders/:id/retry-payment` only allows this when the order is
still `PENDING` and its most recent payment has actually `FAILED` — not
while one is still in flight (which would race two live charge attempts
for the same order) and not once the order is already resolved.

**Live-verified end to end**: reserve → order → deliver a `failed`
webhook → retry-payment (a genuine second `Payment` row appeared against
the same `Order`, exactly matching the schema's own documented
expectation) → the retry's own natural mock confirmation fired 3s later
→ `Order` → `PAID`, reservation → `CONFIRMED`, seat → `SOLD`.

## BigInt over the wire

`Order.amountMinor` and `Payment.amountMinor` are `bigint` (headroom for
summing up to `MAX_SEATS_PER_RESERVATION` seats' prices) — and
`JSON.stringify` cannot serialize a `bigint` at all; it throws. Rather
than a global `BigInt.prototype.toJSON` patch (a common but silent,
action-at-a-distance fix some Node projects reach for), this follows the
same explicit pattern `event-cache.ts`'s `SerializedEvent` already
established for `Date -> string`: `serializeOrder` converts
`amountMinor` to a string, and the wire type (`SerializedOrder`) says so
honestly instead of lying that the HTTP response carries the same shape
Prisma returns. Confirmed live: `amountMinor` arrived as `"500000"`
(a JSON string), not a native number or a crash.

## A real schema gap this phase found and fixed

`Payment.providerRef` had never been marked `@unique` — but a webhook
handler that looks payments up BY `providerRef`
(`findPaymentByProviderRefWithContext`) genuinely needs that guarantee:
without it, nothing in the schema would prevent two different Payment
rows from ever sharing one, which would mean one payment's webhook
could resolve a completely different payment. Added via
`20260901112356_payment_provider_ref_unique`, safe despite the field
starting `null` (Postgres treats every `NULL` as distinct from every
other `NULL` in a unique constraint, so many `PENDING` payments can sit
with `provider_ref = NULL` simultaneously without conflict).

**A separate, pre-existing gap surfaced while generating this
migration, deliberately NOT fixed here**: `prisma migrate diff` also
flagged a missing index on `tickets(reservation_item_id)` that
`schema.prisma` has declared (`@@index([reservationItemId])`) since
Phase 3 but whose migration was apparently never generated — real drift
between the schema file and the actual migration history, unrelated to
payments. Left alone rather than silently bundled into this migration;
worth a deliberate fix when Phase 14 (tickets) actually touches that
table.

## What Phase 13 deliberately does not include

> **Update:** the payment timeout, cancelling while `PENDING_PAYMENT`, and automatic refunds of duplicate/late payments have since been built -- see [checkout-lifecycle.md](checkout-lifecycle.md).

- **Ticket issuance.** A `PAID` order doesn't yet produce a `Ticket`
  row — that's the entirety of Phase 14, a separate model with its own
  partial-unique-index correctness invariant (`tickets_active_
  reservation_item_unique`, already built in Phase 3).
- **A payment timeout.** A reservation that enters `PENDING_PAYMENT` and
  then never resolves (the user abandons checkout, the mock/real
  provider never confirms) stays `PENDING_PAYMENT` forever — the Phase 9
  expiry sweeper only ever matches `status = 'RESERVED'`, so entering
  checkout is (deliberately, for now) a one-way door out of the expiry
  path. A real system would need a symmetric payment-side timeout; not
  built here to keep this phase scoped to the checkout and webhook
  mechanics themselves.
- **Cancelling an order/reservation while `PENDING_PAYMENT`.** The
  existing cancel endpoint only accepts `RESERVED`. Combined with the
  gap above, there is currently no way out of `PENDING_PAYMENT` other
  than an eventual payment outcome — a real, known gap, not an
  oversight, deferred alongside the payment timeout above.
- **Automatic resolution of a genuine double-payment** (two different
  Payment attempts for the same order both actually succeed at the
  provider — a rare but real scenario with any payment gateway). This
  phase detects and records it (`orderAlreadyPaidByAnotherPayment`,
  logged as a warning) but does not attempt an automatic refund — that
  needs a real refund flow this project doesn't build.
- **Multi-currency orders.** `amountMinor`/`currency` assume every seat
  in one reservation shares a currency, true for every seat-generation
  path this codebase has.
