# Transactional outbox (Phase 10)

The pattern that closes the gap between "commit a business change" and
"announce that it happened" — built now because Phase 9 finally gave
this project a business change worth announcing (a reservation being
created, cancelled, or expiring).

## The problem this solves

Once a reservation exists, other parts of a real system will eventually
want to know about it — send a confirmation, update an analytics
counter, warm a cache. The naive way to do that:

```
await prisma.reservation.create(...)
await redis.publish('reservation-created', ...)   // or an HTTP call, or a queue push
```

is a **dual write**: two independent operations that are supposed to
happen together but aren't atomic. If the process crashes, or Postgres
succeeds and Redis is unreachable, between those two lines, the
reservation exists but nothing downstream ever finds out. There is no
way to make this reliable by adding retries around the second call
alone — you'd need to somehow also know, after a crash, whether the
first call already committed.

## The fix: make the announcement part of the same transaction

`schema.prisma`'s `OutboxEvent` model (built in Phase 3, unused until
now) turns "announce this happened" into a plain database `INSERT` — and
a database transaction that includes both the business write and that
`INSERT` is atomic by construction. Either both commit, or neither does.
There is no crash window left to fall into.

```ts
await prisma.$transaction(async (tx) => {
  const reservation = await tx.reservation.create({ ... });
  await tx.reservationItem.createMany({ ... });
  await writeOutboxEvent(tx, {
    aggregateType: 'reservation',
    aggregateId: reservation.id,
    eventType: 'reservation.created',
    payload: { ... },
  });
});
```

`writeOutboxEvent` (`packages/database/src/outbox.ts`) takes the SAME
`tx` handle the business write used — never a fresh `prisma` call. That
single detail is the entire mechanism; everything else in this phase
exists to get that row out of Postgres and onto something consumable.

**Two call sites, both already in this codebase:**
- `reservation.repository.ts`'s `createReservationWithItems` →
  `reservation.created`
- `packages/database`'s `releaseReservation` (shared by the cancel
  endpoint and the expiry sweeper) → `reservation.cancelled` or
  `reservation.expired`, depending on which caller invoked it

## The publisher: PENDING rows become stream entries

A row in `outbox_events` isn't useful to anyone until it leaves
Postgres. `apps/worker/src/jobs/outbox-publisher.ts` polls `WHERE status
= 'PENDING' ORDER BY created_at` every `OUTBOX_PUBLISH_INTERVAL_MS`
(5s — plus once immediately on startup, same reasoning as the
reservation expiry sweeper), `XADD`s each one to `stream:domain-events`,
and flips it to `PUBLISHED`.

Structurally this worker is the reservation-expiry-sweep's twin: a plain
`setInterval`, an immediate first tick, overlap protection (skip a tick
if the previous one is still running), and an `async stop()` that awaits
any in-flight tick before resolving — the same shutdown-ordering
correctness Phase 5 established for the BullMQ workers, applied here
too. Verified live: stopping the worker container logs `"outbox
publisher stopped"` and `"reservation expiry sweeper stopped"` BEFORE
`"prisma disconnected"`, in that order, every time.

## Why a Stream, not Pub/Sub

This is the concrete case the Phase 7 comparison table
(`docs/redis.md`) gestured at without a real example yet. Pub/Sub
delivers a message only to whoever is subscribed **at the instant it's
published** — a message published to zero subscribers is gone forever.
Nothing in this codebase consumes `stream:domain-events` yet (that's
Phase 11), so if the outbox publisher used Pub/Sub, every single event
published before Phase 11 ships would be silently lost, undetectably.
A Stream retains its entries regardless of whether anyone is listening,
which is exactly the property "publish now, consume starting next
phase" needs.

## Why polling, not LISTEN/NOTIFY

Postgres's `LISTEN`/`NOTIFY` would let the publisher react to a new
outbox row instantly instead of waiting up to 5 seconds. It was left out
deliberately: `LISTEN` requires holding one dedicated, always-open
Postgres connection per listener and reacting correctly to that
connection dropping and needing to resubscribe — real operational
complexity for a system that, in its current form, has no requirement
faster than "a few seconds" for anything it publishes. A 5-second poll
is simpler, and the interval is a single named constant
(`OUTBOX_PUBLISH_INTERVAL_MS`) to tune later if that ever changes.

## At-least-once delivery, not exactly-once

If `XADD` succeeds but the process crashes (or Postgres briefly drops
the connection) before the `UPDATE ... SET status = 'PUBLISHED'`
commits, the row is still `PENDING` and gets published again on a later
tick — the SAME event appears twice in the stream, as two separate
entries. This is not a bug to eliminate; it's a well-known, accepted
property of the outbox pattern, and eliminating it would require a
distributed transaction spanning Postgres and Redis, which is far more
machinery than this system needs.

What makes it safe: every stream entry carries an `outboxId` field equal
to the outbox row's own `id`, which stays IDENTICAL across a republish
(unlike the Redis-generated stream ID, which is different every time).
Phase 11's consumer groups are expected to dedupe on exactly this field
via `schema.prisma`'s `ProcessedEvent` table (`@@unique([consumerGroup,
eventId])`, already built in Phase 3) — the same
insert-as-lock idempotency pattern this project already uses for
`idempotency_keys` (Phase 9) and the seat-locking unique index (Phase 3),
applied one more time at the consumer layer.

## Failure handling: retry, then dead-letter

If `XADD` itself fails (a Redis outage, not a "rejected" business
event — there's no such concept for a domain event), the row's
`attempts` counter increments and it stays `PENDING`, so the next tick
retries it automatically. After `OUTBOX_MAX_PUBLISH_ATTEMPTS` (10)
failed attempts, the row is marked `FAILED` instead of being retried
forever. `FAILED` is a genuine dead letter: nothing in this codebase
currently retries or alerts on a `FAILED` row automatically — an
operator has to notice and investigate. Building that automatically
(a dashboard, a paging alert) is a fair Phase 19/20 concern
(observability, production readiness), not something to half-build here
speculatively.

## Live-verified end to end

Against the real Docker stack: creating a reservation produced a
`PENDING` outbox row inside the same transaction; the next publisher
tick (within 5s) flipped it to `PUBLISHED`, logged `"outbox publish tick
completed"`, and the entry appeared in `stream:domain-events` (confirmed
via `XLEN` and `XREVRANGE`) with the expected fields. Cancelling that
same reservation produced a second row (`reservation.cancelled`),
published the same way, through the exact same `releaseReservation`
code path the expiry sweeper also uses.

## Why the outbox event and the AuditLog write are two different things

`recordAuditLog` (used throughout Phases 5–9) and the outbox exist side
by side on purpose, not as redundant mechanisms:

| | AuditLog | OutboxEvent |
|---|---|---|
| Audience | A human reading an admin/incident trail | A future machine consumer (Phase 11+) |
| Transactional with the business write? | No — written as a separate call after | Yes — always |
| Consumed by | Nobody programmatically; queried ad hoc | A dedicated stream consumer |

Reservation creation writes to both, for different reasons: the audit
log because "who did what, when" should be queryable without touching
Redis; the outbox because something else will eventually need to react
to "this happened," reliably, exactly once each downstream consumer
cares about it.

## What Phase 10 deliberately does not include

- **Any stream consumer.** `stream:domain-events` has exactly one writer
  and zero readers as of this phase. Phase 11 (Redis Streams) is
  entirely about building a consumer group against it, including the
  `ProcessedEvent`-backed dedup logic this document already assumes.
- **Automatic recovery of `FAILED` rows** or alerting on them — a
  production-readiness concern for a later phase, not solved
  speculatively now.
- **Outbox events for anything other than reservation lifecycle
  transitions.** Payments, tickets, and other future aggregates
  (Phase 13+) will call the exact same `writeOutboxEvent` helper when
  they exist; there's nothing reservation-specific about the mechanism
  itself.
- **Multiple streams / per-aggregate-type streams.** One shared stream
  is enough at this scale; splitting by aggregate type is a real option
  later if consumer-side filtering ever becomes a bottleneck, not a
  problem this system has today.
