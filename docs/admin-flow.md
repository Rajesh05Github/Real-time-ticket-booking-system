# Admin (Phase 5)

Venue/section/event/seat creation and publish/unpublish, authorized via a
new `requireRole('ADMIN')` guard composed on top of Phase 4's `requireAuth`.

## Data model workflow

Venues and sections are reusable across events (decided back in Phase 3);
seats are event-specific. The realistic admin workflow is therefore:

```
1. POST /api/v1/venues                          -- once per physical venue
2. POST /api/v1/venues/:venueId/sections         -- once per section, ever
3. POST /api/v1/events                           -- once per event (DRAFT)
4. POST /api/v1/events/:eventId/seats            -- once per event, references existing sections
5. POST /api/v1/events/:eventId/publish          -- once seats exist
```

Not the "recreate venue + sections + event + seats in one shot" flow
section 3's literal example suggests — that's the right shape for a
first-time demo walkthrough, wrong for a venue hosting its second event.

## Authorization: two composable hooks, not one

```
requireAuth   -- populates request.session from the cookie, or 401s
requireRole() -- checks request.session.role, or 403s
```

A route needing "any logged-in user" uses `requireAuth` alone (`/me`,
`/logout`). A route needing "an admin specifically" composes both:
`{ preHandler: [requireAuth, requireRole('ADMIN')] }`. Splitting
authentication from authorization this way means neither hook needs to
know about the other's job.

## A real Fastify bug, found and fixed in this phase

`requireRole`'s returned guard function was originally a plain
**synchronous** function. Composed into a preHandler **array** after the
async `requireAuth`, it caused Fastify 5.12.1 to hang the request
indefinitely — no error, no log line, nothing — on the SUCCESS path only
(an admin session that correctly passed both checks). Rejection paths
(401/403, where the guard *throws*) worked fine, which is what made this
easy to miss in casual testing: only a passing admin request took the
hang.

This was found by live bisection against a running container:

1. A standalone Prisma query outside the HTTP layer proved the database
   was never the bottleneck (returned instantly).
2. Live-patching the route handler's body to a static response (no
   service call, no Prisma) **still hung** — proving the problem was in
   the preHandler chain, not the venue/event logic.
3. Live-patching `roleGuard` to be `async` (identical logic, zero
   `await`s added) **fixed it immediately**.

Fix applied to source: every hook composed into a preHandler array in
this codebase is now declared `async`, even ones with nothing to
`await`, specifically to avoid mixing sync and async hooks in one array.
See `apps/api/src/plugins/rbac.ts` for the full comment.

## Visibility rule: one route serves both audiences

`GET /api/v1/events` and `GET /api/v1/events/:eventId` use `optionalAuth`
(populates `request.session` if a valid cookie is present, but never
401s if one isn't) rather than a separate `/admin`-prefixed duplicate.
The service layer enforces visibility:

- No session, or a non-ADMIN session: only `PUBLISHED` events are
  visible. A `DRAFT` event's id returns **404**, not 403 -- a 403 would
  confirm the id exists, leaking a pre-launch event's existence,
  capacity, or pricing to anyone who guesses or is handed the URL.
- An ADMIN session: every status is visible, and the `?status=` filter
  actually applies.

This also means Phase 6 (public event browsing + Redis caching) extends
these SAME handlers rather than building a parallel set — only the
`PUBLISHED`-only path needs a cache in front of it, since an admin's
draft-inclusive view must never be served from a shared cache key.

## Large seat generation: sync below a threshold, background above it

Section 3's flow implies typing in seat codes one at a time; a real
stadium has tens of thousands of them. `POST
/api/v1/events/:eventId/seats` accepts a list of *assignments*
(`{ sectionId, seatCodePrefix, startNumber, seatCount, priceMinor,
currency }`) so an admin generates "500 seats in Section A, ₹500 each"
in one call rather than enumerating codes by hand.

- **Below `SEAT_GENERATION_SYNC_LIMIT`** (200 seats total across all
  assignments, `packages/shared`): created inline, inside the request,
  in one `createMany` call. Returns `201` with the created seats.
- **At or above the threshold**: enqueued as a `generate-seats` BullMQ
  job (same producer/consumer pattern as Phase 4's email queue). Returns
  `202` with a `jobId`. `GET
  /api/v1/events/:eventId/seats/generation-jobs/:jobId` reports live
  progress by querying BullMQ's own job state directly (`job.getState()`,
  `job.progress`) -- no separate progress-tracking table, since BullMQ
  already persists exactly this for the job's lifetime.

Verified live end-to-end: a 50-seat request returned synchronously with
`mode: "sync"`; a 300-seat request returned `202` with `mode: "async"`,
and polling the job-status route showed it reach `state: "completed"`,
`progress: 100`, with the worker's log and a direct Postgres count both
confirming exactly 300 rows created.

The synchronous path does **not** skip duplicate seat codes on conflict
(a real collision should surface loudly to the admin as a 409, not
silently create fewer seats than requested); the background job **does**
skip duplicates (`skipDuplicates: true`), because a retried job re-runs
every chunk from the start, including ones a prior attempt already
inserted -- without it, a retry would fail immediately on its first
already-completed chunk instead of resuming past it.

## `buildSeatRows`: one shared expansion, not two hand-copied loops

The logic that expands `{ seatCodePrefix, startNumber, seatCount }` into
concrete `{ seatCode, ... }` rows lives in `@flashsale/shared`
(`buildSeatRows`), imported by both the synchronous path
(`apps/api`) and the background job (`apps/worker`). A duplicated,
hand-copied version of this loop in each app risked the two paths
silently producing different seat codes for what an admin intended as
the identical request (an off-by-one in one copy, not the other).

## `AuditLog` used for real, for the first time

Every mutation in this phase (venue/section/event creation, publish,
unpublish, seat generation via either path) writes an `AuditLog` row --
the table Phase 3 created but nothing used yet. `recordAuditLog` lives in
`@flashsale/database` (not `apps/api`), specifically so the seat-generation
background job (`apps/worker`) can record what it did on completion too --
apps/worker cannot import apps/api's code, and this is a persistence
concern that belongs next to the Prisma client itself.

## Shutdown ordering: a second real bug, found the same way

While verifying this phase's Docker containers, the worker's shutdown
log showed Prisma disconnecting **before** the BullMQ workers finished
closing -- harmless in that specific run (no job was mid-flight at
shutdown time), but a real bug: an in-flight job's final step (writing
its audit log row, updating a Notification's status) needs a live Prisma
connection, and a SIGTERM arriving mid-job would have made that write
fail. The cause: `shutdown.ts`'s handlers run in *reverse* registration
order by design, and Prisma's disconnect hook had been registered
*last*, making it run *first*. Fixed by registering it first instead, so
it correctly runs last -- after both workers have drained. See
`apps/worker/src/index.ts`'s comment for the full reasoning.

## What Phase 5 deliberately does not include

- **Public event browsing UI or Redis caching** -- Phase 6.
- **Editing/deleting sections or venues** -- not needed yet; sections are
  additive-only for now.
- **Cascading cancellation** when an event is unpublished or its status
  otherwise changes -- reservations/tickets don't exist yet (Phase 9+).
- **CANCELLED as a reachable status** via any route -- only
  publish/unpublish are implemented; cancellation semantics (refunds,
  notifying ticket holders) are a later phase's concern.
