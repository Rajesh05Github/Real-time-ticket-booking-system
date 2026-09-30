# Redis (Phase 7: fundamentals)

Every Redis key used in FLASHSALE so far, why each data structure was
chosen over the alternatives, and what happens to each one under
concurrency and on a Redis restart — section 47/48's required registry
and learning table, finally written now that enough real usage exists to
document honestly instead of speculatively.

Every key is built through `packages/redis/src/keys.ts`'s `redisKeys`
object — never a string literal in a service file. That file is the
authoritative source for each key's exact format; this document is the
narrative explanation of *why*.

## Complete key registry

| Key | Type | TTL | Owner | Written by | Read by |
|---|---|---|---|---|---|
| `otp:user:{userId}` | Hash | 300s | auth module | register, resend-otp | verify-otp |
| `otp:user:{userId}:cooldown` | String | 60s | auth module | register, resend-otp | register, resend-otp (via `NX`) |
| `session:{sessionId}` | Hash | 7 days | auth module | login | every `requireAuth`/`optionalAuth` call |
| `cache:event:{eventId}` | String (JSON) | 300s | events module | cache miss, admin write invalidation | public event detail reads |
| `lock:cache:event:{eventId}` | String | 5s | events module | cache miss (rebuilder) | stampede-waiting requests (via `NX`) |
| `notifications:user:{userId}` | List | none (length-bounded) | notifications module | every notification created | `GET /notifications` |
| `event:{eventId}:watchers` | Set | none | events module | watch/unwatch | watch status, watcher count |
| `event:{eventId}:views` | String (counter) | none | events module | every non-admin detail view | (exposed via trending only, not directly) |
| `event:trending` | Sorted Set | none | events module | every non-admin detail view; `ZREM` on unpublish | `GET /events/trending` |

Full per-key documentation (exact TTL constants, cleanup behavior, the
reasoning behind each) lives as a JSDoc comment directly above each key
builder in `packages/redis/src/keys.ts` — this table is the map; that
file is the territory.

## The data structure learning table (section 48)

For each structure: why this one, why not another, what happens under
concurrency, what happens if Redis restarts.

### String

**Used for:** OTP hash, resend cooldown, cache-aside JSON blob, cache
rebuild lock, per-event view counter.

**Why String:** it's the only structure that's *just a value* — no
internal fields, no ordering. Every one of these uses cases is
fundamentally "one value, keyed by one thing": one OTP hash per user, one
cached blob per event, one counter per event.

**Why not something else:** a Hash would work for the OTP (it already
has two fields, `hash` and `attempts`) and IS used there for exactly that
reason — String was the wrong choice for OTP specifically, which is why
it's a Hash instead. For the cache blob and the counter, a Hash would be
pure overhead: there's only one field, so Redis's Hash bookkeeping buys
nothing.

**Under concurrency:** `INCR` (the view counter) is atomic at the Redis
level — two concurrent requests both calling `INCR event:{id}:views`
are guaranteed to produce two SEPARATE increments (e.g. 5 then 6), never
a lost update where both read 5 and both write 6. This is the same class
of guarantee (single-threaded command execution) that makes `SET ... NX`
usable as a lock. Compare this to what an application-level "read counter,
add one, write it back" would do under the same race: two concurrent
readers could both read `5`, both compute `6`, and both write `6` —
one increment silently lost. `INCR` makes that entire class of bug
structurally impossible rather than something to be careful about.

**On restart:** every String key here is either self-expiring (OTP,
cooldown, cache, lock) or fine to lose (the view counter is explicitly
documented as an approximate, non-critical metric). None of these are a
correctness concern if Redis restarts without persistence.

### Hash

**Used for:** OTP state (`hash`, `attempts`), session state (`userId`,
`role`, `createdAt`, `lastActivityAt`).

**Why Hash:** both of these are a small, fixed set of related fields that
are always read and written together as one logical record. A Hash lets
`HSET`/`HGETALL` treat them as one unit while still allowing a targeted
`HINCRBY attempts` (OTP) or `HSET lastActivityAt` (session) without
rewriting the whole record.

**Why not String:** you'd have to serialize/deserialize JSON on every
read and write, and lose the ability to atomically increment just the
`attempts` field without a read-modify-write race (see String's `INCR`
discussion above — the exact same problem reappears if you fake a
counter through JSON instead of using Redis's native field-level ops).

**Under concurrency:** `HINCRBY` (OTP's attempt counter) has the same
atomicity guarantee as `INCR` — two concurrent wrong-guess requests for
the same OTP correctly produce two separate increments, never a lost
one. This is what actually makes the brute-force attempt cap
(`OTP_MAX_ATTEMPTS`) trustworthy under concurrent guesses, not just
under sequential ones.

**On restart:** both self-expire via TTL and are treated as ephemeral by
design (session is deliberately paired with a low-frequency Postgres
audit row precisely because the Hash itself is expected to be
disposable — see `docs/auth-flow.md`).

### List

**Used for:** `notifications:user:{userId}`, the recent-activity feed.

**Why List:** `LPUSH` + `LTRIM` is the standard, minimal-code idiom for
"keep the N most recent items, discard older ones" — exactly what a
capped recent-activity feed needs, with the newest item always at index
0.

**Why not something else — the comparison section 56 asks for:**

| | List | Redis Stream | BullMQ | Pub/Sub |
|---|---|---|---|---|
| Answers | "recent items" | "what happened" (durable, replayable) | "what work needs doing" | "tell whoever's listening right now" |
| Durability | As durable as Redis itself | Durable + consumer-group tracked | Durable (Redis-backed job data) | **None** — a message with no subscriber is gone |
| This feature needs | A capped list, no replay, no consumer tracking | Overkill — nobody needs to replay "which notifications existed" from an offset | Wrong tool — nothing here needs to be *processed*, just *displayed* | Wrong tool — a user checking their feed later must still see it; Pub/Sub couldn't deliver anything from before they connected |

Concretely: this feed is read on-demand (`GET /notifications`), not
processed by a worker and not something a disconnected client needs
replayed to it later. That combination is precisely what a List is for
and precisely what the other three structures are overkill or flatly
wrong for. Streams and Pub/Sub get their own dedicated phases (11 and
15) once there's a feature that actually needs "what happened, in order,
replayable" or "push this to whoever's connected right now."

**Under concurrency:** two concurrent `LPUSH`es (e.g. two notifications
created for the same user in quick succession) are individually atomic —
neither push is lost — but their relative ORDER isn't something the
application controls beyond "whichever LPUSH Redis executes first ends
up further from the head." For a human-facing "recent activity" feed
where two notifications land within the same few milliseconds, this is
irrelevant; nothing depends on sub-second ordering being exact.

**On restart:** explicitly a "fast VIEW, not a second source of truth"
per its key-registry entry — if lost, nothing is actually lost, since
every entry references a Postgres `Notification` row that's still there
(`docs/database.md`).

### Set

**Used for:** `event:{eventId}:watchers`.

**Why Set:** "is this user watching" and "how many users are watching"
are exactly `SISMEMBER` and `SCARD` — a Set's two defining operations.
Membership is inherently deduplicated: adding the same user twice
(`SADD` called again) is a no-op, which is exactly the semantics
"watching" needs (there's no such thing as watching an event twice).

**Why not a List:** a List would allow the same user to appear multiple
times (calling "watch" twice would double-count them in `LLEN`), and
checking "is this user watching" would be an O(n) scan instead of O(1).

**Deliberately NOT the same concept as section 19's real-time "viewer
presence":** a Set backing a live WebSocket "who's currently looking at
this page" feature would need join-on-connect/leave-on-disconnect
semantics tied to a connection lifecycle — genuinely Phase 15/19 work,
once Pub/Sub and WebSocket infrastructure exist to drive it. Watching
here is a persistent, explicit user action with no connection lifecycle
attached; conflating the two would have been the wrong abstraction for
both.

**Under concurrency:** `SADD`/`SREM` are atomic; two concurrent watch
requests from the same user cannot produce two entries (Set semantics
prevent that by definition), and a concurrent watch+unwatch race
resolves to whichever command Redis executes last, which is the correct,
expected outcome for "last write wins" on a boolean-ish membership flag.

**On restart:** persists until explicitly removed, no TTL — this is
intentional (a user's expressed interest in an event shouldn't
evaporate because Redis happened to restart), which also means it's the
one structure in this table where losing it on an unpersisted restart
IS a real (if low-stakes) data loss, not a designed-in disposability.
This is exactly the trade-off the Phase 2 AOF persistence decision exists
to cover — see `docs/deployment.md`.

### Sorted Set

**Used for:** `event:trending`.

**Why Sorted Set:** trending is fundamentally a ranking question —
"which N events have the most views" — and `ZREVRANGE ... WITHSCORES`
answers it directly, in Redis, in O(log n) per update and O(log n + m)
per range read. The alternative (fetch every event's counter, sort in
application code) doesn't scale past a handful of events and does the
sorting Redis is already good at, in the wrong tier of the system.

**Why two structures (String counter AND Sorted Set) for what looks like
the same number:** they answer different questions on purpose — see the
key registry's `event:trending` entry. `event:{id}:views` is "how many
times has THIS event been viewed" (meaningful in isolation, e.g. for an
admin dashboard stat); `event:trending`'s score is "how does this event
compare to every OTHER event" (only meaningful as a ranking). A single
structure can't cheaply answer both: a Sorted Set has no per-member
O(1) "just give me this one's value as a plain counter" outside of
`ZSCORE` (which works, but conflates "current rank-relevant score" with
"total count" in a way that becomes a real problem the moment those two
numbers need to diverge — e.g. if trending later becomes a decayed/
weighted score while the raw view count needs to stay a true total).

**Under concurrency:** `ZINCRBY` has the same atomic
read-modify-write-in-one-step guarantee as `INCR`/`HINCRBY` — concurrent
views of the same event correctly accumulate without a lost update.

**On restart:** no TTL, persists until explicit `ZREM` (on unpublish).
Same AOF-persistence consideration as the watchers Set above; losing it
on an unpersisted restart would reset trending rankings to zero, which
is a real but low-severity loss (self-heals as new views come in), not a
correctness bug.

## What Phase 7 deliberately does not include

- **Unique-view deduplication.** Every request increments
  `event:{id}:views`, with no dedup by session/IP/time window — this
  measures request volume, not unique visitors. A production version
  would either track recent viewers in a short-TTL Set (paying the
  membership-check cost per view) or accept an approximate unique count
  via `PFADD`/`PFCOUNT` (HyperLogLog) — genuinely useful, deliberately
  not built here to keep this phase's counter section focused on the
  atomicity lesson, not estimation algorithms.
- **Cleanup of the trending Sorted Set for events that are simply old**
  (rather than unpublished) — an event that stops being viewed just sinks
  toward the bottom of the ranking naturally; nothing purges it. If this
  set grows unbounded over the platform's lifetime, that's a fair
  candidate for a future periodic trim job, not solved speculatively now.
- **HyperLogLog, Bitmaps, Geo commands** — not used by any current
  feature; introducing them without a concrete need would be exactly the
  premature complexity section 58 warns against.
