# Event Browsing (Phase 6)

Public event list/detail/search/filter, and the cache-aside pattern for
`GET /events/:eventId` described in section 4.

## Cache-aside, with stampede protection

```
GET /api/v1/events/:eventId
  ↓
non-admin caller?
  ├─ no (ADMIN) → read Postgres directly, ALWAYS live, cache never touched
  └─ yes → cache:event:{eventId}
             │
             ├─ HIT → return cached JSON (Postgres never touched)
             │
             └─ MISS → acquire lock:cache:event:{eventId} (SET NX EX)
                          │
                          ├─ acquired  → query Postgres → SET cache (EX 300s) → DEL lock → return
                          │
                          └─ not acquired (someone else is rebuilding)
                                → wait 50ms, re-check cache, up to 3 times
                                → still nothing? read Postgres directly anyway
```

Verified live against the running Docker stack, not just written and
assumed correct:

- A cache miss populates `cache:event:{id}` with `TTL=299` (one second
  already elapsed from `EX 300`).
- Manually overwriting the cached value with `redis-cli SET` and
  re-requesting the event returns the **tampered** value — proof the
  hit path genuinely reads from Redis rather than happening to match
  Postgres by coincidence.
- An admin `PATCH` on that same event correctly invalidates the tampered
  key and the next public read reflects the real, updated data.
- An admin `GET` on a tampered-cache event returns the real Postgres
  data (bypasses the cache entirely) while a public `GET` in the same
  moment still sees the tampered value — proof the admin path is a
  genuinely separate read, not a shared one with a bypass flag.
- Unpublishing invalidates the cache and the public route correctly
  404s afterward instead of serving a stale "still published" copy.

### Why the admin path bypasses the cache entirely, not just on a miss

Two independent reasons converge on the same answer:

1. **Freshness**: an admin who just edited or published an event needs
   to see that change immediately. A cache with a 5-minute TTL sitting
   between them and their own write would be a confusing, self-inflicted
   bug ("I just saved this, why does it still show the old value?").
2. **Confidentiality**: a `DRAFT` event's data must never be written into
   `cache:event:{id}` at all — that key is readable by any unauthenticated
   request. The loader function passed to `getOrSetEventCache` only ever
   returns a row when `status === 'PUBLISHED'`; a `DRAFT`/`UNPUBLISHED`
   result is treated as "not found" and is never cached, by construction,
   not by a separate check bolted on afterward.

### Why stampede protection, and why this specific shape

Without it: when a hot event's cache entry expires (or is invalidated by
an admin edit) at the exact moment a flash-sale-level burst of requests
arrives for it, every one of those requests would independently miss the
cache and hit Postgres simultaneously — the "thundering herd" problem.
For a single event row this is a small effect, but it's the same
mechanism that would hurt far more under Phase 9's reservation load, so
it's worth building and understanding correctly now, at low stakes.

The lock (`lock:cache:event:{id}`, `SET NX EX`) is the same primitive
section 5's seat-reservation lock uses, applied to a different problem:
here it's optimizing *how many* requests hit Postgres on a miss, not
*preventing an incorrect result* — even with zero stampede protection,
concurrent misses reading Postgres and writing the same cache value
would still be correct, just wasteful. That's why every Redis call in
`event-cache.ts` is wrapped to fail **open**: if Redis is down, this
degrades to a plain Postgres read on every request (slower, still
correct), never an error. See section 44's "what happens if Redis fails"
principle, applied here for real.

Bounded retries (3 attempts, 50ms apart), not a wait loop: a lock
holder that crashes mid-rebuild is recovered by the lock's own 5-second
TTL, not by anyone waiting on it — so a waiter gives up after ~150ms and
just reads Postgres itself rather than risk blocking on a lock that might
never be released by a process that no longer exists.

## Search, filtering, and pagination

`GET /api/v1/events` accepts `search` (case-insensitive substring match
on name/description — deliberately not full-text search; see the
schema's comment for why reaching for that now would be premature),
`venueId`, `startTimeFrom`/`startTimeTo`, and `page`/`pageSize`
(capped at 100). A non-admin's `status` filter is silently ignored, not
rejected, for the same reason `GET /events/:eventId` 404s instead of
403s on a draft event — the endpoint behaves as if the parameter was
never sent rather than confirming that non-`PUBLISHED` events exist to
filter by.

## Why the list route is NOT cached

> **Update:** the public list IS now cached, using a generation counter instead of per-key invalidation -- see [checkout-lifecycle.md](checkout-lifecycle.md#public-event-list-cache). The reasoning below is why the naive approach was avoided.

Section 4's example only shows caching the detail route, and that's
deliberate, not an oversight to fix later. `GET /events/:eventId` has
exactly one natural, low-cardinality cache key per event. `GET
/events` with five optional, freely-combinable filter parameters has an
effectively unbounded key space — caching it well would need real
machinery (hashing the query into a cache key, a much shorter TTL to
bound staleness across that many possible keys, and invalidating on
*every* event write instead of just the one event that changed, since
any write could affect any filtered list's result set). That's
legitimate work for a future phase if list-query load ever demands it,
not something to bolt on speculatively now (section 58).

## What Phase 6 deliberately does not include

- **Caching the list route** — see above.
- **Full-text search** — `contains` substring matching only.
- **Frontend pages** (`/events`, `/events/[eventId]`) — this phase is the
  API layer; section 31's Next.js pages consume these same endpoints
  whenever the frontend work happens.
- **Negative caching** (caching a "not found" result) — a 404 always hits
  Postgres. At this project's read volume the added complexity (a
  separate short-TTL negative-cache key, careful invalidation on the
  event later being created) isn't worth it yet.
