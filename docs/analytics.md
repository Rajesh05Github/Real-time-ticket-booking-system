# Phase 16 — Analytics via a Second, Independent Consumer Group

## The lesson: consumer groups are independent by construction

Phase 11 built exactly one consumer group (`notifications`) reading
`stream:domain-events`, and `docs/streams.md` explicitly flagged what it
was deferring: *"nothing stops a future phase from adding an independent
one... reading the same stream at its own pace -- that's the whole point
of consumer groups being independent -- but building a second one now
with nothing real to consume for would be speculative."*

Phase 16 is that future phase. `ANALYTICS_CONSUMER_GROUP` reads the exact
same stream, from the exact same beginning (`XGROUP CREATE ... '0'`), with
its own cursor, its own Pending Entries List, and its own dedup ledger
(`ProcessedEvent` rows keyed on `(group, outboxId)` -- Phase 11's dedup
mechanism already supported more than one group, it just never had a
second one to prove it with). Nothing about adding this group touches
`notifications`'s code, data, or delivery guarantees. Live-verified: after
driving one full reservation -> order -> payment flow, `XINFO GROUPS`
showed both groups independently at `pending: 0, lag: 0` against the same
stream.

## Extracting the shared loop (`stream-consumer-loop.ts`)

Two real consumer groups now exist with genuinely identical mechanics
(create-group, XAUTOCLAIM stale entries, blocking XREADGROUP, dedup, ACK,
error handling that leaves a failed message un-ACKed for XAUTOCLAIM to
retry). That's the point where extracting a shared `startStreamConsumerLoop`
helper stopped being premature and started being the same "two concrete
call sites" rule this codebase applies everywhere else (see e.g.
`docs/payment-flow.md`'s provider abstraction, built only once a second
provider was actually needed). `domain-event-consumer.ts` was refactored
onto this shared loop in the same phase, preserving its exact external
behavior (its existing test suite required zero changes) while removing
~90 lines of loop mechanics duplicated into `analytics-consumer.ts`
otherwise.

Each consumer now supplies only what's actually different: the consumer
group name, and an `onNewEvent(event)` callback.

## What gets counted, and how

`analytics-consumer.ts`'s `onNewEvent` is deliberately generic for the
counting half, matching the notification consumer's own "no per-eventType
branching" discipline:

```
redis.hincrby('analytics:eventCounts', event.eventType, 1)
```

Every event type this codebase has ever emitted -- `reservation.created`,
`reservation.cancelled`, `reservation.expired`, `order.created`,
`order.paid`, `payment.failed` -- increments its own field with zero code
change required. A brand-new event type a future phase introduces starts
appearing here automatically.

Revenue is the one place this consumer DOES branch, because "realized
revenue" only means something for exactly one event type:

```
if (event.eventType === 'order.paid') {
  redis.hincrby('analytics:revenueMinorByCurrency', currency, amountMinor)
}
```

`order.created` was deliberately NOT chosen for this -- an order exists
the instant a fan submits payment details, before the payment provider
has confirmed anything, so counting revenue there would count orders
whose payment goes on to fail. `order.paid` is the one point in this
codebase's whole lifecycle where money has definitely, unconditionally
changed hands.

### A payload change this phase needed, and why it's scoped tightly

`order.paid`'s outbox payload previously carried `orderId`/`paymentId`/
`userId`/`reservationId` only -- no amount at all. Phase 16 added
`amountMinor`/`currency`, sourced from `payment.order.amountMinor`/
`.currency` (the ORDER's authoritative total, not the triggering
Payment's -- a Payment can be a retry attempt for the same order via
`createRetryPayment`, docs/payment-flow.md, so `Payment.amountMinor` isn't
guaranteed to be the right total to attribute revenue to, though in
every current flow they're equal). This is one field addition to one
existing payload, not the multi-payload restructuring Phase 15 explicitly
declined to do for live seat-map broadcasting -- a difference in scope,
not a change of principle.

**Live-verified, and it caught something real (in the sense of validating
the design, not a bug):** four `order.paid` events already sitting in
Postgres from Phase 13/14's own testing predate this payload change and
have no `amountMinor` field. Replaying the whole stream from '0' (a
brand-new consumer group always does) meant the analytics consumer
processed those old-shaped events too. It handled them exactly as
designed: logged `"order.paid event missing amountMinor/currency --
skipping revenue rollup"` and still counted the event in
`analytics:eventCounts`, without crashing or corrupting the revenue
figure. The final revenue total (`INR: "500000"`, one order's worth) is
correct precisely because those four older events were skipped, not
double-counted or coerced into `NaN`.

### Why the increment is passed as a string, not `Number(amountMinor)`

`amountMinor` arrives from the outbox payload as a string (this
codebase's established bigint-over-JSON convention -- see
`docs/payment-flow.md`). `HINCRBY`'s increment argument is parsed by
Redis as a 64-bit integer regardless of whether ioredis sends it as a JS
`number` or a `string`; routing it through `Number(...)` first buys
nothing and risks silent precision loss for very large totals. Read side
(`GET /api/v1/analytics/summary`) preserves the same discipline: `HGETALL`
naturally returns strings, and the route does not convert them to
`number` before responding.

## The read side: `GET /api/v1/analytics/summary`

Admin-only (`requireAuth` + `requireRole('ADMIN')`, the same
`adminOnly` pattern every other admin route in this codebase uses), and
deliberately thin -- a direct `HGETALL` on each hash, no aggregation of
its own. The consumer is the only writer; this route's whole job is
"return what's there," the same read-side/write-side split as
`event-cache.ts`'s cache-aside read.

## What Phase 16 deliberately does not include

- **A time-windowed view** (revenue per day/hour, a trending-events
  leaderboard). Both hashes are lifetime, all-time counters, matching
  `eventViewCounter`'s existing precedent (`docs/redis.md`) -- a
  time-bucketed version would need its own key-per-window scheme and
  wasn't needed to demonstrate the actual lesson (a second independent
  consumer group).
- **A second XAUTOCLAIM cursor persisted across restarts.** Same accepted
  simplification Phase 11 already documented for `domain-event-consumer.ts`,
  now shared by both consumers via the extracted loop.
- **Retrying `xack` in `readNewMessages`'s "already processed" branch
  after a Redis outage.** Same class of gap as every other Redis write in
  this codebase that isn't wrapped in its own retry loop -- a genuinely
  down Redis already breaks the whole consumer's `xreadgroup` call before
  this path is ever reached.
