# Phase 15 — Redis Pub/Sub & Live Viewer Presence

## The mental model

Every prior real-time-ish mechanism in this codebase is *durable*: the outbox
(Phase 10) writes rows nobody can lose, Streams (Phase 11) keep a replayable
log with consumer-group acknowledgment, BullMQ (Phase 12) persists jobs in
Redis until they're processed. Pub/Sub is the odd one out, deliberately:

> Tell whoever's listening **right now**. If nobody's listening, the message
> is gone forever. There is no queue, no replay, no acknowledgment.

That's the correct tool for "broadcast the current viewer count to open
WebSocket connections" — a client that wasn't connected a second ago doesn't
need to be told what it missed, it'll get the current count the moment it
*does* connect (see the join ordering below). Using Streams or a queue here
would be solving a durability problem this feature doesn't have.

## Why a dedicated subscriber connection

Once a Redis connection issues `SUBSCRIBE`, that connection can (per the
Redis protocol) only issue a small set of pub/sub commands — it can no
longer run arbitrary commands like `GET`/`SET`/`PUBLISH`. This is the same
connection-exclusivity lesson as Phase 11's blocking `XREADGROUP` calls:
some Redis commands claim the whole connection.

`live-broadcast.ts` therefore creates its own Redis client
(`subscriberRedis`) purely for subscribing, completely separate from
`app.redis` (the general-purpose connection used everywhere else in the API,
including this same plugin's `publish()`).

## Why ONE subscriber connection per process, not one per client

A naive design would open a fresh Redis connection per WebSocket client and
have it `SUBSCRIBE` directly. That works but doesn't scale — hundreds of
concurrent viewers would mean hundreds of Redis connections, most of them
idle almost all the time.

Instead, `liveBroadcastPlugin` keeps exactly one `subscriberRedis` connection
for the whole `apps/api` process, plus an in-memory
`Map<channel, Set<listener>>`. Real Redis `SUBSCRIBE`/`UNSUBSCRIBE` calls
only happen on the actual transitions that matter:

- `SUBSCRIBE <channel>` — only when the **first** listener for that channel
  is registered.
- `UNSUBSCRIBE <channel>` — only when the **last** listener for that channel
  is removed.

Every listener in between is pure in-process routing: the connection's
`'message'` event handler looks up `listenersByChannel.get(channel)` and
calls each one directly, no extra Redis round-trip. Two people watching the
same event share one subscription; a hundred people watching the same event
still share that one subscription.

## The join/leave lifecycle (`event-live.routes.ts`)

```
1. SUBSCRIBE this connection's onMessage listener to the event's channel.
2. THEN join presence (SADD) and PUBLISH the new count.
3. On close: leave presence (SREM), PUBLISH the new count, THEN unsubscribe.
```

Step 1 happens *before* step 2 on purpose. Because this connection is
already subscribed by the time it joins presence and publishes the new
count, its own join message flows back to it through the exact same
fan-out path every other connection's messages take — there's no need for
a special "also send the current count directly to the connecting socket"
branch. One code path, no special case.

Live-verified against the running Docker stack: connecting client A receives
`{"type":"viewerCount","count":1}` on join; connecting client B while A is
still open causes **both** A and B to receive `{"type":"viewerCount","count":2}`
(proving the channel fan-out actually reaches multiple independent socket
connections, not just the one that triggered the publish); closing B causes
A to receive `{"type":"viewerCount","count":1}`.

## Presence storage (`event-presence.ts`, `redisKeys.eventLivePresence`)

Presence is a plain Redis Set, keyed per event
(`presence:event:<eventId>`), with one member per open connection
(a random UUID generated per socket, not a user id — this feature is
fully anonymous/public). `SCARD` after every `SADD`/`SREM` gives the
current viewer count.

`joinPresence`/`leavePresence` fail **open**: on a Redis error they return
`null`, not `0`, so the route handler can tell "Redis is unreachable, don't
publish a bogus count" apart from "the count genuinely just became zero."

### Known, deliberately unfixed gap

Every other ephemeral Redis structure in this codebase (rate-limit windows,
idempotency keys, seat locks) has a TTL or an explicit cleanup path. The
presence Set does not: it's cleaned up on the WebSocket `'close'` event, but
if the `apps/api` **process** dies (not just one socket closing) — a crash,
an OOM kill, `docker kill -9` — the Set entries for that process's
connections are never removed, and the viewer count reported to future
connections stays inflated until process restart (nothing ever `FLUSHDB`s
it, but it's also not user-facing data that outlives a deploy in any
harmful way).

Fixing this properly would mean a per-connection heartbeat + TTL
reconciliation loop, which is real complexity for a feature whose whole
point in this project is *demonstrating* Redis Pub/Sub fan-out, not
building production-grade presence tracking. Documented here (and in
`packages/redis/src/keys.ts`) as an accepted simplification, not an
oversight.

## What this phase deliberately does NOT do

> **Update:** live seat-map updates have since been built as a third consumer group publishing onto this same channel -- see [checkout-lifecycle.md](checkout-lifecycle.md#live-seat-maps).

**Live seat-map updates** (broadcasting real-time seat status changes —
"seat A12 was just reserved" — to every connected viewer) were considered
and explicitly deferred. Building that on top of this plugin would need
`eventId`/`seatIds` added to several outbox payloads that currently lack
them (`reservation.cancelled`, `reservation.expired`, `order.paid`), plus a
consumer that translates those domain events into `liveBroadcast.publish()`
calls — roughly doubling this phase's scope for a feature this project's
spec doesn't require yet. Viewer-count presence is the complete lesson for
"what Pub/Sub fan-out looks like end to end"; seat-map broadcasting is a
natural, but separate, future extension if a later phase calls for it.
