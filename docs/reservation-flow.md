# Seat reservation (Phase 9)

The correctness-critical phase of the whole project: how a multi-seat
claim is actually made safe under concurrency, why the Redis lock is
explicitly NOT what makes that true, and how a hold expires.

## The mental model, stated up front

**Postgres is the correctness boundary. Redis is admission control.**
Every design decision below follows from taking that split literally,
not just as a slogan. If you remember one thing from this document,
remember that a Redis outage can make reservations slower or noisier —
it can never make them wrong.

## The claim flow

`POST /api/v1/reservations` (auth required, `Idempotency-Key` header
required):

1. **Validate the request shape.** Reject duplicate seat IDs in the same
   request outright (`DUPLICATE_SEAT_IDS`) — no distributed system
   question here, just bad input.
2. **Confirm the event and seats exist and belong together** (same
   visibility rule as `getEventForViewer`: a non-`PUBLISHED` event is a
   404, not a 403 — see `docs/event-browsing.md`). This is an existence
   check, not a race — existence doesn't change out from under a
   request the way *availability* does, so there's no reason to
   re-check it inside a transaction.
3. **Acquire a Redis lock per seat** (`lock:seat:{seatId}`, `SET NX EX
   10`), in sorted order. This is where "admission control" earns its
   name: it exists purely to stop an obviously-contended seat from
   wasting a Postgres transaction, nothing more.
4. **One transaction**: create the `Reservation` row, `INSERT` one
   `ACTIVE` `ReservationItem` per seat, flip those seats to `RESERVED`.
5. **Release the Redis locks** (`finally`, unconditional — released
   whether the claim succeeded, failed on contention, or failed on an
   unrelated database error).

## Why the partial unique index — not the Redis lock — is what actually works

This was decided back in Phase 3 and is worth restating here now that
it's finally load-bearing:

```sql
CREATE UNIQUE INDEX "reservation_items_active_seat_unique"
  ON "reservation_items"("seat_id")
  WHERE "status" = 'ACTIVE';
```

Two transactions racing to `INSERT` an `ACTIVE` row for the same
`seat_id`: exactly one succeeds, the other raises Postgres error `23505`
(unique violation). `reservation.service.ts` catches that specific error
(`Prisma.PrismaClientKnownRequestError` with `code === 'P2002'`) and
turns it into `409 SEAT_NOT_AVAILABLE` — the exact same catch-and-
translate pattern `venue.service.ts` already used for section names, one
phase earlier.

**The Redis lock in step 3 is not involved in this guarantee at all.**
Walk through what happens if it were deleted entirely: every request
would skip straight to step 4, more transactions would race each other
at the database, and the ONE THING THAT WOULD CHANGE is how often a
request gets a wasted round-trip before its unique-constraint violation
comes back — never whether a seat can be double-booked. That's the
concrete, testable meaning of "admission control, not correctness" used
throughout this project since section 0's spec review.

**Live-verified, not just asserted:** ten concurrent requests for the
same seat, each with its own `Idempotency-Key`, fired at the real Docker
stack — exactly one came back `201`, the other nine came back `409
SEAT_NOT_AVAILABLE`, and a direct query afterward showed exactly one
`ACTIVE` `reservation_items` row for that seat. Every one of the nine
losing `idempotency_keys` rows was independently recorded as `COMPLETED`
with `response_status = 409` — see the idempotency section below for why
that specific detail matters.

## Idempotency: the OTHER correctness problem this phase closes

A seat-claim endpoint has a second, unrelated failure mode a unique
index does nothing about: a client's own network retry (a double-click,
a timeout-then-resend) hitting the SAME endpoint TWICE with the intent
of "book these seats" ONE time. Without protection, that's not a
double-booking bug in the seat-locking sense — it's the same user
successfully claiming two different sets of seats (or the same set
twice, if the seats are still available) because the server has no way
to tell "this is a retry" from "this is a new request."

`packages/database`'s `IdempotencyKey` model (section 22, built in
Phase 3, unused until now) is the fix: `POST /reservations` **requires**
an `Idempotency-Key` header. `apps/api/src/plugins/idempotency.ts`:

- **`idempotencyGuard(route)`** (a preHandler): `INSERT`s an
  `IN_PROGRESS` row keyed by `(route, key)`. The `@@unique([route,
  key])` constraint IS the lock — two truly simultaneous requests
  carrying the same key can't both win that `INSERT`, closing the
  "both checked, neither saw an existing row" race a naive
  check-then-insert would miss. This is the exact same
  unique-index-as-lock idea `reservation_items` uses, one layer up the
  stack.
  - Losing the `INSERT` (a real `P2002`) means: if the stored row's
    `requestHash` doesn't match this request's body, `409
    IDEMPOTENCY_KEY_REUSED` (reject silent reinterpretation of a
    changed request under an old key). If it matches and the row is
    still `IN_PROGRESS`, `409 REQUEST_IN_PROGRESS` (a concurrent
    duplicate, not a retry of a finished one). If it matches and the
    row is `COMPLETED`, the stored response is replayed **verbatim**,
    without the route handler running again at all.
- **`registerIdempotencyPersistence(app)`**: the app-wide hook pair that
  turns a fresh `IN_PROGRESS` row into a stored, replayable result.
  Registered once in `app.ts` via `idempotencyPlugin`.

### Cached by status code, not by success/failure

A `>=500` response deletes the `IN_PROGRESS` row instead of completing
it — an unexpected failure (a bug, a dependency outage) should be
retryable with the SAME key, not permanently frozen into a 500 the
client can never get past. Everything below 500 — a `201` success
exactly as much as a `409 SEAT_NOT_AVAILABLE` — is a deterministic
outcome of that request's input and gets cached as `COMPLETED`. This is
why the nine losing requests in the concurrency test above each
independently ended up `COMPLETED` at `409`: that outcome IS the correct,
stable answer for that key forever, not a transient failure to paper
over.

### A real bug this caught live: don't do async I/O inside `onSend`

The first version of `registerIdempotencyPersistence` did the actual
`prisma.idempotencyKey.update()` call inside Fastify's `onSend` hook,
`await`-ing it before returning the payload. Every request that used it
worked *correctly* from the client's point of view in a quick manual
check — until a live test with `curl -o file -w '%{size_download}'`
showed a `201` with a `size_download` of `0`, and the API's own logs
showed, immediately after a normal "request completed" line:

```
"Reply was already sent, did you forget to \"return reply\" ...?"
Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
```

An `onSend` hook that awaits real I/O runs into Fastify's own
reply-lifecycle bookkeeping: by the time the awaited database call
resolves, Fastify has moved on in a way that makes finishing the send
from inside that hook unsafe, corrupting the very response the hook was
trying to help finish. The fix was to split the work: `onSend` now only
captures the already-serialized payload into a request-scoped field —
synchronously, no `await` anywhere in it — and the actual
`prisma.idempotencyKey` write happens in `onResponse`, which fires
strictly *after* the response has been fully flushed and never touches
the reply object at all (the same hook `app.ts`'s own request-logging
already uses, for the same reason). Re-verified against the live stack
afterward: full response body, zero warnings, unchanged idempotency
behavior.

**The lesson generalizes**: `onSend` is for cheaply transforming or
inspecting a payload, not for I/O with its own latency. `onResponse` is
the hook for side effects that only need to happen *after* the client
has their answer.

## Expiry: the sweeper, not (yet) a BullMQ job

A `RESERVED` reservation holds its seats for `RESERVATION_HOLD_SECONDS`
(10 minutes). What un-holds it if the client never pays and never
cancels?

`apps/worker/src/jobs/reservation-expiry-sweep.ts`: every
`RESERVATION_SWEEP_INTERVAL_MS` (30s) — plus once immediately on worker
startup, so a freshly-deployed worker doesn't leave a backlog sitting
unswept for a full interval — it queries `WHERE status = 'RESERVED' AND
expires_at < now()` (the exact index `schema.prisma`'s `Reservation`
model added in Phase 3 for this query) and releases each one via
`releaseReservation(id, 'EXPIRED')`.

**Deliberately a plain `setInterval`, not a BullMQ repeatable job.**
`packages/shared/src/queues/queue-names.ts`'s own comment has said since
Phase 4 that `reservationExpiryQueue` is Phase 12 work — a BullMQ
**delayed job per reservation**, scheduled at claim time, that races
this sweeper for near-instant expiry instead of waiting up to 30
seconds. That's a latency improvement, explicitly not a correctness
requirement: the sweeper alone is already fully authoritative (nothing
about "a hold outlives its time" depends on Redis or a queue being
healthy), which is precisely why it was safe to build the sweeper now
and defer the BullMQ complement to a later phase without leaving a
correctness gap in between.

**One release path, two callers.** `releaseReservation` (`packages/
database/src/reservations.ts`) is called by both the sweeper (`EXPIRED`)
and the user-initiated `DELETE /reservations/:id` cancel endpoint
(`CANCELLED`) — living in `packages/database` for the same reason
`recordAuditLog` does: `apps/worker` has no Fastify instance to hang a
service module off of, but both processes must run the exact same
transaction, not two independently-maintained copies that could drift.

**Race-safe by construction, not by locking.** The release transaction's
`UPDATE ... WHERE status = 'RESERVED'` (not a plain `UPDATE ... WHERE
id = ?`) means a user cancelling a reservation in the same instant the
sweeper decides it just expired can't both succeed — whichever `UPDATE`
lands first flips the row; the other's `updateMany` matches zero rows
and reports `released: false` rather than double-firing the seat-release
side effects (an `AVAILABLE` seat's status wouldn't be *wrong* if it ran
twice, but the second run finding "nothing to release" is the honest
answer, not a race the caller has to reason about).

**Shutdown ordering matters here too.** `stop()` doesn't just
`clearInterval` — it awaits any tick already in flight, closing the
exact class of bug Phase 5 fixed for the BullMQ workers (Prisma
disconnecting while a live query is still running), applied to a plain
timer instead of a queue worker. Caught by writing the regression test
for it, not by re-discovering the Phase 5 bug live a second time.

## What Phase 9 deliberately does not include

> **Update:** idempotency-key cleanup has since been built (hourly worker job) -- see [checkout-lifecycle.md](checkout-lifecycle.md#housekeeping-idempotency-keys).

- **A BullMQ delayed job for expiry** — Phase 12, as above. The sweeper
  alone is correct; the delayed job is a latency optimization on top of
  it, not a prerequisite for it.
- **The transactional outbox** — a claim's audit log write and its
  (future) "reservation created" event publish are not yet wrapped in
  the outbox pattern. Phase 10's entire job is making that
  publish-after-commit step crash-safe; introducing it piecemeal here
  would duplicate work Phase 10 does properly.
- **Payment / order creation** — a `RESERVED` reservation has no `Order`
  yet. Phase 13 adds the transition to `PENDING_PAYMENT` and beyond.
- **Waitlisting or seat-swap on contention** — a `409 SEAT_NOT_AVAILABLE`
  is currently just an error the client's UI has to handle (e.g. "pick
  different seats"); there's no server-side "try an equivalent seat
  instead" logic, which is a product decision this phase doesn't make.
- **Cleanup of old `COMPLETED`/terminal `idempotency_keys` rows.** They
  accumulate forever as written. A production system would eventually
  need a retention job (e.g. delete rows older than N days past
  `completedAt`) — a fair, low-urgency candidate for a later phase, not
  solved speculatively now.
