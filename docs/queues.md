# BullMQ: retry/backoff/DLQ and the expiry race (Phase 12)

## A gap this phase found, not just filled

`email-worker.ts`'s own docstring has claimed, since Phase 4, that the
email queue gets "automatic retry with backoff on a failed
`emailProvider.send()` call." That was never actually true. Neither
`emailQueue` nor `seatGenerationQueue` ever set `defaultJobOptions` —
and BullMQ's real default is `attempts: 1`. Every OTP email and every
bulk seat-generation job has been running with **zero retries** since
the phase that introduced it, silently, because nothing ever exercised
a real transient failure in local testing to surface it. This phase's
retry/backoff pass is a correctness fix for existing queues, not just
new configuration for a new one.

## The policy, per queue

| Queue | Attempts | Backoff | Why |
|---|---|---|---|
| `emailQueue` | 5 | exponential, 5s base | A third-party email API blip is exactly the kind of transient failure retry exists for; failing an OTP delivery after one try would lock a user out of registering for no good reason. |
| `seatGenerationQueue` | 3 | exponential, 10s base | A bulk-insert failure is more likely a real database problem than a blip — retrying aggressively is less likely to help and more likely to hammer an already-struggling database. Safe to retry at all only because `skipDuplicates` (Phase 5) makes a retried job idempotent. |
| `reservationExpiryQueue` | 3 | exponential, 5s base | Low-stakes either way: this job is a latency optimization (see below), and the Postgres sweeper is the correctness backstop regardless of whether this job ever succeeds. |

Every number lives in `packages/shared/src/queues/queue-names.ts` as a
named constant — never a magic number at the `new Queue(...)` call
site.

## The dead-letter queue is BullMQ's own failed set — not a new queue

`removeOnFail` defaults to "keep forever," which is unbounded growth
without being an intentional design. This phase sets it to `{ count:
1000 }` — the most recent 1000 failed jobs stay inspectable via
`queue.getFailed()` (or `redis-cli LRANGE bull:<queue>:failed 0 -1`),
older ones age out. That bounded failed set **is** this project's
dead-letter queue. Building a separate hand-rolled DLQ queue that
failed jobs get moved into would be exactly the redundant machinery
section 58 warns against — BullMQ already has a working, inspectable
concept for "a job that exhausted every retry," and reusing it is the
right call at this scale. `removeOnComplete` is bounded the same way,
for ordinary Redis-memory hygiene (nothing reads completed job history
today).

## Closing the "then what?" gap for a job that's truly failed

Configuring retries answers "try again," but a job that exhausts every
attempt still needs *something* to happen — otherwise the underlying
record (a `Notification` row, in the email queue's case) sits at
`PENDING` forever with no visible sign anything went wrong. Once retries
existed, this became answerable: `email-worker.ts`'s `on('failed', ...)`
handler now checks `job.attemptsMade >= job.opts.attempts` (the FINAL
attempt, not an intermediate retry) and flips the `Notification` to
`FAILED` when it's true. Before this phase, that row would have stayed
`PENDING` invisibly after a silent final failure — not just slow, wrong.

## Phase 12's actual new queue: `reservationExpiryQueue`

Phase 9's sweeper comment promised this: a BullMQ **delayed job**, added
once per successful claim (`delay: RESERVATION_HOLD_SECONDS * 1000`),
racing the Postgres sweeper for near-instant expiry instead of waiting
up to `RESERVATION_SWEEP_INTERVAL_MS` (30s).

**The race is resolved by the exact same mechanism that makes the
sweeper and the cancel endpoint safe to run concurrently with each
other**: `releaseReservation`'s `WHERE status = 'RESERVED'` guard
(`packages/database`, Phase 9). This job doesn't implement any new
coordination logic at all — it just calls `releaseReservation` and
doesn't even inspect whether `released` came back true or false.
Whichever of the three callers (this job, the sweeper, a user
cancelling) reaches Postgres first wins; the other two silently no-op.
That symmetry is what makes it correct to enqueue this job
unconditionally on every claim, with no bookkeeping to cancel it if the
reservation resolves some other way first — a stale delayed job simply
fires later and finds nothing to do.

**Live-verified, not just read from the code:** creating a reservation
produced a real BullMQ delayed job in Redis (`bull:reservationExpiryQueue:
delayed`) with `delay: 600000` and the exact configured retry policy
(`attempts: 3, backoff: { type: 'exponential', delay: 5000 }`) already
attached — proving the `defaultJobOptions` wiring, not just the code
that sets it. Forcing that job to fire early (moving its score in the
delayed set) showed the worker pick it up, call `releaseReservation`,
flip the reservation to `EXPIRED`, and the Phase 10/11 outbox pipeline
immediately publish and consume the resulting `reservation.expired`
event — the full Phase 9 → 10 → 11 → 12 chain working together end to
end.

**Deliberately not stored on the Reservation row**: the job's BullMQ id
isn't tracked anywhere, so cancelling a reservation can't (and doesn't
try to) remove its pending delayed job. That job just fires later,
finds `status` is no longer `RESERVED`, and no-ops. Tracking and
actively cancelling it would save a small, bounded amount of wasted
Redis/CPU work at real implementation cost (a new column, a new
BullMQ `.remove()` call, more failure modes to reason about) for a
benefit this project's scale doesn't need yet.

## Why the payload carries only an id

`ExpireReservationJobData` is `{ reservationId: string }` — nothing
else. Contrast with `SendOtpEmailJobData`, which DOES carry the OTP
itself. The difference is deliberate: an OTP's validity is time-boxed
and its value has to travel with the job because the source of truth
(a Redis key) could expire before the job runs. A reservation's
*current* status can only be answered correctly by reading it fresh at
process time — carrying a stale "was RESERVED when enqueued" snapshot
would risk the job blindly expiring a reservation the user already paid
for in the ~10 minutes between enqueue and this job actually firing.

## What Phase 12 deliberately does not include

- **`notificationQueue`, `paymentQueue`, `analyticsQueue`** — Phase 4's
  original plan for this phase. `notificationQueue` turned out
  unnecessary once Phase 11's Streams consumer group solved fan-out
  better than a queue would have; the other two have no real job to
  define until Phases 13 and 16 make the decisions their payloads
  depend on. See `queue-names.ts`'s own comment for the full
  correction.
- **Tracking/cancelling the delayed expiry job on cancel**, as covered
  above.
- **A UI or endpoint for inspecting the failed-job set.** `getFailed()`
  and direct Redis inspection work today; a proper dashboard is a
  production-readiness concern for a much later phase.
