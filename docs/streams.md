# Redis Streams: the consumer side (Phase 11)

Phase 10 built the producer half of the outbox pipeline (the transaction
that writes an `OutboxEvent` row, and the publisher that turns it into a
stream entry). This phase builds the other half: something that actually
reads `stream:domain-events`, durably and idempotently, via a real Redis
consumer group.

## What it does

`apps/worker/src/consumers/domain-event-consumer.ts` reads every entry
published to `stream:domain-events` and fans it out to the affected
user's notification feed (the same Redis List `pushToRecentFeed` writes
to, built in Phase 7 for OTP emails). A reservation being created,
cancelled, or expiring now shows up in `GET /api/v1/notifications`
alongside OTP notifications, with zero eventType-specific code in the
consumer -- it only knows "push an entry for whichever user this event's
payload names."

## Why `pushToRecentFeed` moved out of apps/api

It used to live in `apps/api/src/modules/notifications/`. This phase's
consumer needs the exact same function, and `apps/worker` cannot import
`apps/api`'s code -- the same constraint that put `recordAuditLog`
(Phase 5) and `writeOutboxEvent`/`releaseReservation` (Phases 9-10) in
`packages/database` instead of an app. `pushToRecentFeed`/`getRecentFeed`
now live in `packages/redis` for the identical reason, one implementation
shared by apps/api's auth flow and apps/worker's new consumer.

## Consumer groups and why this needed one

A plain `XREAD` (no group) has no memory: every reader gets every entry
from wherever it starts, with no concept of "I've already seen this
one" and no way for a second reader to pick up the load. A **consumer
group** (`XGROUP`, `XREADGROUP`) adds exactly the bookkeeping a durable
subscriber needs:

- Each entry is delivered to exactly one consumer within the group (not
  broadcast to all of them) -- this is what lets multiple worker
  replicas eventually share the load, something a plain `XREAD` can't do.
- Delivered-but-not-yet-acknowledged entries sit in the group's
  **Pending Entries List (PEL)** until `XACK`'d. If the consumer that
  received one crashes before acking it, the entry doesn't vanish -- it
  stays claimable by whoever asks.

The group here (`notifications`, `NOTIFICATION_CONSUMER_GROUP`) is
created starting at ID `'0'`, not `'$'` -- a brand-new group should
process the entire backlog already in the stream, not only entries
added after it was created. Verified live: on this worker's first ever
startup, it caught up on two pre-existing entries from Phase 10's own
testing (one of which -- created before this phase added `userId` to
the cancel/expiry outbox payload -- correctly logged a warning and
skipped notification fanout instead of crashing, proving the
"generic, no eventType branching" design handles a real historical gap
gracefully rather than needing a special case for it).

## Idempotent processing: dedup on `outboxId`, not the stream ID

Every message is checked against `tryMarkEventProcessed` (`packages/
database`, backed by `ProcessedEvent`'s `@@unique([consumerGroup,
eventId])`) before being processed. The `eventId` used is the
`outboxId` field carried on the stream entry -- the outbox row's own
id -- never the Redis-generated stream ID. `docs/outbox.md` already
explains why: the SAME outbox row can appear as multiple different
stream IDs if the publisher's at-least-once delivery re-adds it after a
crash, and it's the logical event that needs deduplicating, not each
individual delivery attempt.

**Live-verified, not just asserted:** the same `outboxId` was manually
`XADD`'d a second time (simulating exactly this kind of redelivery). The
consumer picked it up, `tryMarkEventProcessed` correctly returned
`false` the second time, and the notification feed still showed exactly
one entry for that id -- not two. (The console also printed a raw,
unstructured `Unique constraint failed` line from Prisma's own default
error logging at that moment -- a pre-existing, cross-cutting wrinkle in
`packages/database/src/client.ts`'s `log` config that prints every P2002
Prisma sees regardless of whether the calling code catches it, present
since Phase 4/5 and affecting every P2002-catch pattern in this
codebase, not something Phase 11 introduced. Noted here rather than
fixed, since changing it is a cross-cutting logging decision outside
this phase's scope.)

## Crash recovery: `XAUTOCLAIM`

If a consumer dies mid-`processMessage` (after `XREADGROUP` delivered a
message, before `XACK`), that message sits in the PEL forever unless
something reclaims it. Every loop iteration calls `XAUTOCLAIM` first,
reassigning any message that's been pending longer than
`STREAM_CONSUMER_CLAIM_IDLE_MS` (30s) to the current consumer, then
processes whatever it claimed through the exact same `processMessage`
path new messages use -- safe to do because that path is already
idempotent via `tryMarkEventProcessed`.

**Deliberately simplified for now**: `XAUTOCLAIM`'s scan cursor is
restarted at `'0-0'` on every call rather than resumed from where the
previous call left off. At this project's message volume that's cheap
and correct; a high-throughput production consumer would track and
resume the cursor instead of rescanning from the start every time. Noted
explicitly in the code as a LOCAL DEVELOPMENT SIMPLIFICATION, not left
implicit.

## Blocking reads, not polling -- a deliberate contrast

Every other periodic job in this codebase so far (the reservation
expiry sweeper, the outbox publisher) is a plain `setInterval`: wake up,
do a fixed amount of work, sleep. This consumer is structurally
different -- a continuous loop built around `XREADGROUP ... BLOCK
5000`, which asks Redis to hold the connection open and return the
INSTANT a new entry arrives (up to the block timeout). That's a real
capability the other two jobs' underlying data (a Postgres table) simply
doesn't offer: Postgres has no "block until a matching row appears"
primitive without `LISTEN`/`NOTIFY` (deliberately not used --
`docs/outbox.md` covers why), while Streams offer blocking reads as a
first-class feature.

The practical consequence for shutdown: `stop()` on this consumer can't
"clear a timer" the way the sweeper/publisher's `stop()` does. It sets a
`stopped` flag and awaits the entire run loop's promise, which only
resolves once the current `XREADGROUP` call returns (worst case,
`STREAM_CONSUMER_BLOCK_MS`) and any message it's mid-processing
finishes. Verified live: a real `docker stop` showed `"domain event
consumer stopped"` logged before the outbox publisher, sweeper, BullMQ
workers, and finally Prisma -- `handlerCount: 6`, clean shutdown well
under a second.

## What Phase 11 deliberately does not include

- **A second consumer group.** One group (`notifications`) exists.
  Nothing stops a future phase from adding an independent one (e.g. an
  analytics counter, Phase 16) reading the same stream at its own pace
  -- that's the whole point of consumer groups being independent -- but
  building a second one now with nothing real to consume for would be
  speculative.
- **Cursor-persisting `XAUTOCLAIM`**, as noted above.
- **Multiple consumer instances actually load-balancing.** The consumer
  name (`${hostname()}:${process.pid}`) is already unique per process,
  so running two worker replicas would correctly split the stream
  between them with no code change -- just nothing in this project runs
  more than one worker replica yet to exercise that path live.
- **Fixing Prisma's default stderr error logging** for expected/handled
  errors like the P2002 this phase's dedup check catches -- a
  pre-existing, cross-cutting behavior noted above, not new to this
  phase and not fixed here.
