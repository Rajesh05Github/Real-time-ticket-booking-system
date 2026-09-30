# Checkout lifecycle: timeouts, cancellation, refunds

This closes the gaps that Phases 13–15 recorded as deliberately deferred:

- A checkout could sit in `PENDING_PAYMENT` forever.
- A checkout couldn't be cancelled.
- A double payment was only logged, never refunded.
- A paid booking couldn't be cancelled.
- Seat maps didn't update live.
- Nothing ever cleaned up `idempotency_keys`.

It also covers the public event-list cache and real email delivery.

## The state machine

```
                   POST /reservations
                          │
                          ▼
     ┌──────────────── RESERVED ─────────────────┐
     │ hold expires (600s)   │ POST /orders      │ user cancel
     ▼                       ▼                   ▼
  EXPIRED            PENDING_PAYMENT          CANCELLED
                 (deadline extended to 900s)
     ┌──────────────┬────────┴─────────┬────────────────────┐
     │ checkout     │ user cancel      │ webhook: succeeded │ webhook: failed
     │ timeout      │                  ▼                    ▼
     ▼              ▼              CONFIRMED            (stays PENDING_PAYMENT,
  EXPIRED       CANCELLED        order PAID,            order PENDING, retry allowed)
  order         order            tickets ISSUED
  CANCELLED     CANCELLED              │ POST /orders/:id/cancel
                                       ▼
                                  CANCELLED, order REFUNDED,
                                  tickets CANCELLED, seats AVAILABLE,
                                  payment REFUND_PENDING → REFUNDED (worker)
```

## One lock order for every lifecycle transaction

These transactions can race each other:

- the expiry sweeper
- the BullMQ expiry job
- a user cancelling
- the payment webhook
- a payment retry
- cancelling a paid booking

Every one of them starts with `lockReservation()`
(`SELECT … FROM reservations WHERE id = $1 FOR UPDATE`,
`packages/database/src/reservations.ts`). They then re-read
status/deadline *under the lock* and act on what they find. With one
global lock order they serialize instead of deadlocking, and whichever
arrives first wins. Everything that arrives later sees the new state and
does nothing.

`checkout-lifecycle.integration.test.ts` races `releaseReservation`
against `applyPaymentSucceeded` on real Postgres. Every round ends in
exactly one of two consistent outcomes, never a mix:

- *(PAID, seat SOLD, 1 ticket)*
- *(CANCELLED, seat AVAILABLE, refund queued)*

## Checkout timeout

`POST /orders` moves the reservation to `PENDING_PAYMENT` **and** extends
its `expiresAt` to now + `CHECKOUT_TIMEOUT_SECONDS` (15 minutes). The
sweeper's existing `(status, expiresAt)` query now covers both states, so
one index and one loop handle holds and abandoned checkouts alike.

`releaseReservation(id, 'EXPIRED')` checks the deadline under the lock.
The BullMQ delayed job fires at the *original* 10-minute hold deadline,
so without that check it would cancel a checkout that is legitimately
still in progress.

## Money is never dropped: refunds

A successful charge can arrive for an order that can no longer take it:

- **`order_not_payable`**: the checkout was cancelled or timed out
  first. Its seats may already belong to someone else.
- **`duplicate_payment`**: a different attempt already paid the order.

In both cases the webhook marks the payment `REFUND_PENDING` and writes a
`payment.refund_requested` event, in the same transaction.
`REFUND_PENDING` is a **durable refund intent**, committed before any
external call. The worker's refund processor
(`apps/worker/src/jobs/refund-processor.ts`) sends it back through the
provider that took the money (`Payment.provider`). The payment id is the
provider-side idempotency key, and the payment is marked `REFUNDED` only
after the provider accepts. A crash at any point just means the next tick
(every 10s) retries it, never a second refund.

Cancelling a paid booking (`POST /orders/:orderId/cancel` on a `PAID`
order) uses the same pipeline. Customers can do this until the event
starts; admins can do it at any time. One transaction:

- order → `REFUNDED`
- payment → `REFUND_PENDING`
- tickets → `CANCELLED`
- reservation → `CANCELLED`, items released, seats back to `AVAILABLE`
- an `order.refunded` outbox event

The partial unique indexes (`reservation_items … WHERE status='ACTIVE'`,
`tickets … WHERE status='ISSUED'`) let the freed seat be reserved and
ticketed again. The integration test does exactly that.

The analytics consumer subtracts `order.refunded` amounts, so the
dashboard shows **net** revenue.

## Endpoints

| Route | What |
|---|---|
| `DELETE /reservations/:id` | Now also works while `PENDING_PAYMENT` (cancels the pending order). |
| `POST /orders/:orderId/cancel` | `PENDING` → cancel the checkout. `PAID` → cancel tickets and refund. Requires `Idempotency-Key`. Owner or admin. |

## Live seat maps

A third consumer group on `stream:domain-events` (`live-seats`,
`apps/worker/src/consumers/live-seat-consumer.ts`) maps seat-changing
events to seat statuses and PUBLISHes them on the event's existing live
channel:

| Event | Seat status |
|---|---|
| `reservation.created` | `RESERVED` |
| `reservation.cancelled` / `reservation.expired` / `order.refunded` | `AVAILABLE` |
| `order.paid` | `SOLD` |

The api's live-broadcast plugin already fans that channel out to every
WebSocket on every instance. The browser patches just the changed seats.
It also drops a seat from the user's selection, with the same amber flash
as a 409, if someone else takes it first.

This needed `eventId` and `seatIds` in those outbox payloads, which were
added. The group is created at `$`, not `0`, so a fresh deploy doesn't
replay stream history as a burst of stale updates.

The browser opens **one** socket per event per tab, shared by the viewer
badge and the seat map (`apps/web/src/lib/hooks/use-event-live.ts`).
Before, two sockets would have counted each viewer twice.

Latency is one outbox publish tick plus one consumer read: a few seconds.
Pub/Sub has no replay, so a missed message is corrected by the next full
availability fetch.

## Housekeeping: idempotency keys

`idempotency_keys` previously grew forever. The worker now deletes, every
hour:

- `COMPLETED` rows older than 24h, which is past any realistic retry
  window.
- `IN_PROGRESS` rows older than 10 minutes. These are left behind by a
  process that died mid-request. Otherwise they would answer every retry
  of that key with `REQUEST_IN_PROGRESS` forever.

## Public event-list cache

`GET /events` for non-admin callers is cached for 30s. The key is a hash
of the normalized query plus a generation counter
(`cache:events:list:generation`). Every event update, publish or
unpublish INCRs the counter, which orphans every cached page at once with
no SCAN and no per-key bookkeeping. Admin lists (which can include
drafts) bypass the cache. Every Redis failure falls back to Postgres.

## Email delivery

`EMAIL_PROVIDER` selects `console` (dev), `smtp` (any relay) or `acs`
(Azure Communication Services). The worker validates each provider's
required settings at boot. It also warns loudly if it is running
`console` in production. See `.env.example` and
[azure-deployment.md](azure-deployment.md).

## Also fixed along the way

- **WebSockets through nginx**: `infra/nginx/nginx.conf` never forwarded
  `Upgrade`/`Connection` headers. The live viewer count therefore could
  never connect through the full Docker stack, only via `api:4000`
  directly.
- **Duplicate payment crash**: `applyPaymentSucceeded` used to try to
  issue tickets a second time for a genuine duplicate payment. That hits
  the tickets partial unique index and rolls the webhook back with a 500.
  Duplicates now go straight to the refund path.
