# Phase 19 — Failure Testing

Every prior phase's "live verification" step tested the HAPPY path against
a healthy Docker stack. This phase deliberately breaks the stack instead
-- stopping Redis, stopping Postgres, and killing the worker mid-job --
against the real running containers, and records what ACTUALLY happened,
not what the code comments claimed would happen. Two of the three
experiments below found a real, fixed bug; the third confirmed an
existing design claim holds for real.

## Experiment 1: Redis outage during live traffic

**Hypothesis going in:** this codebase's own comments repeatedly claim
"fail open" behavior when Redis is unreachable -- seat locks
(`reservation.service.ts`), rate limiting, the event cache, live
presence. `docs/redis.md` and several `packages/redis/src/keys.ts`
entries describe this as a deliberate design property.

**Procedure:** `docker stop flashsale-redis-1`, then hit `/health`,
`/ready`, an authenticated `GET /api/v1/me` (existing session cookie),
and `POST /api/v1/reservations` (a real seat claim) while Redis was down.

**Observed, BEFORE any fix:**

| Check | Result |
|---|---|
| `GET /health` | `200` -- correct, this is liveness, not readiness |
| `GET /ready` | `{"status":"degraded","checks":{"redis":"error"}}` -- correct |
| `GET /api/v1/me` (existing session) | **Hung past 8 seconds with zero response** |
| `POST /api/v1/reservations` | Also blocked, until Redis was restarted, then succeeded |

**Root cause:** `packages/redis/src/client.ts`'s general client sets
`enableOfflineQueue: true` (queue commands issued while disconnected
rather than reject them immediately) with NO `commandTimeout`. That means
a command issued during an outage sits queued indefinitely -- it doesn't
reject at all until the connection actually recovers. This directly
undermines every fail-open `try/catch` in this codebase: a `catch` block
can only run once the `await` it wraps actually rejects, and none of them
ever did during a real, sustained outage. A brief blip (sub-connection-
timeout) still resolves silently exactly as intended; a REAL outage
doesn't degrade gracefully, it just... waits, holding the request (and
the underlying HTTP connection) open the whole time.

**Fix:** `createRedisClient` now accepts an opt-in
`{ commandTimeout: 2000 }`. apps/api's general request-path client
(`plugins/redis.ts`) and the Pub/Sub subscriber client
(`plugins/live-broadcast.ts`) both opt in -- a real outage now surfaces
as a rejected promise within 2 seconds, giving every existing fail-open
branch an actual chance to run. This is deliberately NOT a blanket
default on `createRedisClient`: apps/worker's stream consumers
(`domain-event-consumer.ts`, `analytics-consumer.ts`) issue `XREADGROUP
... BLOCK 5000` -- a legitimate 5-second wait under completely normal,
healthy operation. A global 2s timeout would misfire on every idle poll
cycle, not just real outages, so those two connections were deliberately
left without one.

**A second, related gap fixed alongside it:** session data lives ONLY in
Redis -- unlike seat locks or the event cache, there is no fail-open
fallback possible for "who is this request from" (Postgres's `Session`
table is an audit trail, not a fast-path lookup -- see
`docs/auth-flow.md`). Before this phase, a Redis error during session
lookup fell through `error-handler.ts`'s generic catch-all as a
misleading `500 INTERNAL_SERVER_ERROR`, indistinguishable from an actual
application bug. `auth-hook.ts`'s `resolveSession` now catches that
specific failure and throws the new `ServiceUnavailableError` (503,
`SERVICE_UNAVAILABLE`) instead -- a `503` correctly tells a client "this
is a known, temporary dependency problem, retry shortly," which a `500`
does not.

**Re-verified after the fix:**

| Check | Before | After |
|---|---|---|
| `GET /api/v1/me` (existing session) | Hung past 8s, no response | `503 SERVICE_UNAVAILABLE` in ~2.18s |
| `POST /api/v1/reservations` | Hung past 8s, no response | `503 SERVICE_UNAVAILABLE` in ~2.13s |

**A more precise, honest finding worth stating plainly:** the reservation
request above returns `503` at the AUTH step, before ever reaching
`acquireSeatLocks`'s own fail-open `try/catch`. That's correct, not a
gap: `requireAuth` runs first in the preHandler chain, and session
verification has no fail-open fallback (see above) -- a FULL Redis outage
blocks the whole authenticated pipeline at that first step, full stop.
The seat-lock fail-open path this codebase's comments describe is real
and does work (confirmed in the very first, pre-fix run of this
experiment, where the reservation eventually succeeded once Redis
reconnected and everything queued through), but a full outage doesn't
actually exercise it in isolation -- only a PARTIAL degradation would (Redis
reachable enough for session hashes, but the specific `SET NX` admission
lock failing), which is harder to simulate with a blunt `docker stop` and
was left out of this phase's scope (see below).

## Experiment 2: Postgres outage during live traffic

**Hypothesis:** unlike Redis, Postgres is a hard dependency almost
everywhere in this codebase -- there's no fail-open story for "the
database is unreachable." The bar here isn't graceful degradation, it's
FAILING CLEANLY: a real 5xx with no leaked internals, `/ready` correctly
reporting the outage, and neither `api` nor `worker` hanging or crashing.

**Procedure:** `docker stop flashsale-postgres-1`, then hit `/health`,
`/ready`, `GET /api/v1/me`, and `GET /api/v1/events`, while watching
`apps/worker`'s logs (the outbox publisher and reservation-expiry
sweeper both run on a `setInterval`, independent of any one HTTP
request).

**Observed:**

| Check | Result |
|---|---|
| `GET /health` | `200` -- correct, liveness is unaffected |
| `GET /ready` | `{"status":"degraded","checks":{"database":"error","redis":"ok"}}` -- correct |
| `GET /api/v1/me` | `500 INTERNAL_SERVER_ERROR` in ~4s -- a real error, not a hang, not a leaked stack trace |
| `GET /api/v1/events` | Same: clean `500` in ~4s |
| `apps/worker` logs | `"outbox publish tick failed"` / `"reservation expiry sweep tick failed"` logged every tick, worker process stayed up the whole time (`docker ps` never showed a restart) |

No bug found here -- this is exactly the designed behavior. The ~4s
figure (vs. Redis's clean, immediate `ECONNREFUSED`) reflects Prisma's
own connection-acquisition retry/timeout behavior against a fully-down
TCP target, not an application-level hang; it's bounded and consistent
across repeated requests, not indefinite the way the Redis case was
before its fix.

**Recovery:** `docker start flashsale-postgres-1`, then -- with NO
restart of `api` or `worker` -- `GET /ready` returned to
`{"status":"ok",...}` and `GET /api/v1/events` returned `200` within
seconds. Prisma's connection pool reconnects on its own once the
database is reachable again; nothing in this codebase needed to notice
or react to the recovery explicitly.

## Experiment 3: worker killed mid-job (SIGKILL, not graceful SIGTERM)

**Hypothesis:** every previous phase's shutdown testing used `docker
stop` (SIGTERM), exercising this codebase's graceful-drain path -- the
one it's DESIGNED to hit. A real crash doesn't send SIGTERM first. This
experiment checks whether the outbox + Streams + BullMQ combination
(Phase 10-12) is durable against an ungraceful kill, not just a
cooperative shutdown.

**Procedure:**
1. Created a reservation as the fan user (writes an `outbox_events` row,
   status `PENDING`, and schedules a BullMQ delayed expiry job) --
   `POST /api/v1/reservations`.
2. IMMEDIATELY, before the next outbox-publish tick could run:
   `docker kill -s SIGKILL flashsale-worker-1` (not `docker stop` --
   this sends SIGKILL directly, skipping the graceful-shutdown path
   entirely; `docker ps -a` confirmed `Exited (137)`, the signal-9 exit
   code).
3. While the worker was dead, inspected Postgres and Redis directly.
4. Restarted the worker and re-checked.

**Observed, while the worker was dead:**

| What | Result |
|---|---|
| `outbox_events` row for this reservation | Still `PENDING` -- untouched, not lost, not corrupted |
| BullMQ's delayed job (`bull:reservationExpiryQueue:delayed`) | Still present in Redis's sorted set |

Neither surprising nor a bug -- Postgres and Redis are the durable stores
here BY DESIGN (docs/outbox.md, docs/queues.md); the worker process
itself holds no state that a crash could lose. This is exactly the point
of the outbox pattern and BullMQ's Redis-backed persistence: the worker
is disposable, the data isn't.

**Observed after `docker start flashsale-worker-1`:**

| What | Result |
|---|---|
| The same `outbox_events` row | Flipped `PENDING` -> `PUBLISHED` on the first publish tick after restart |
| `XINFO GROUPS stream:domain-events` | Both `notifications` and `analytics` consumer groups at `pending: 0, lag: 0` -- fully caught up |
| Fan's notification feed | Contains the `reservation.created` entry for this exact reservation (`id` matches the outbox row) |
| `analytics:eventCounts` | `reservation.created` incremented |

No bug found -- this is the outbox/Streams/BullMQ durability story working
exactly as every prior phase's docs claimed, confirmed for the first time
against an actual ungraceful process kill rather than a cooperative
shutdown or a unit test's mocked Redis/Prisma.

**What this experiment deliberately did NOT test:** catching a stream
message truly IN FLIGHT (delivered via `XREADGROUP` but not yet `XACK`'d)
at the exact moment of a kill, which would exercise `XAUTOCLAIM`'s
30-second stale-message reclaim instead of the simpler "the row was never
even published yet" case above. That requires precise timing this
experiment didn't attempt to engineer -- `docs/streams.md` already covers
`XAUTOCLAIM`'s mechanics and Phase 11's own live verification of it.

## What Phase 19 deliberately does not include

- **Fixing every fail-open path's OWN behavior** -- this phase fixed the
  one thing that was breaking ALL of them at once (commands never
  rejecting), not each individual `try/catch` block's specific handling,
  which was already correct in every case checked (seat locks, rate
  limiting).
- **Circuit breakers, health-check-driven traffic shedding, or
  connection-pool tuning.** Those are real, valid responses to a
  dependency outage, but belong to Phase 20's production-hardening pass,
  not a retroactive addition the moment failure testing demonstrates a
  dependency CAN fail (every dependency can fail; that alone doesn't
  justify a circuit breaker for a teaching project's current scope).
- **Chaos-testing every dependency combination** (Redis AND Postgres both
  down, network partitions between containers, disk-full scenarios).
  Three targeted experiments were chosen because they map directly to
  this codebase's three most-repeated resilience claims (Redis fail-open,
  Postgres as the correctness authority, worker crash recovery via
  BullMQ/Streams) -- not because they're exhaustive.
