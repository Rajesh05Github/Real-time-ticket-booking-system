# Rate limiting (Phase 8)

Section 20's gap, finally closed: the auth endpoints most attractive to
an attacker or a misbehaving client — register, login, resend-otp,
verify-otp — are now capped per source IP, backed by Redis so the limit
holds across however many API instances end up behind the load balancer.

## Why Redis, not an in-process counter

An in-memory counter (a plain `Map<ip, count>` inside the Node process)
works fine with exactly one API instance. The moment there are two (which
this project explicitly designs for — see `docs/deployment.md`'s
horizontal-scaling notes), it stops meaning anything: an attacker hitting
instance A and instance B alternately gets twice the real limit, because
neither instance knows what the other has counted. Redis is the one piece
of shared state every API instance already talks to, so it's the natural
place to put a limit that has to hold true across all of them.

## The algorithm: fixed window, not sliding window or token bucket

`consumeRateLimit` (`packages/redis/src/rate-limiter.ts`) implements the
simplest of the three standard approaches:

- **Fixed window** (chosen): count requests in the current N-second
  window; reset to zero when the window rolls over. One `INCR`, one
  conditional `EXPIRE`.
- **Sliding window log**: keep a timestamp per request (e.g. in a Redis
  List or Sorted Set) and count how many fall within the trailing N
  seconds. Precise, but more Redis operations and more memory per key.
- **Token bucket**: tokens refill continuously at a fixed rate; a request
  costs one token. Smooths bursts better than a fixed window, but needs
  to track a fractional refill amount, which means storing a float and a
  last-refill timestamp instead of a single integer.

Per section 58 (don't reach for more machinery than the problem needs):
a fixed window is the right choice here. The known weakness — a client
could send `limit` requests right at the end of one window and another
`limit` right at the start of the next, briefly allowing close to `2×
limit` in a short span around the boundary — is a real trade-off, not an
oversight, and it's a perfectly acceptable one for "slow down a
brute-force attempt," which doesn't need to be precise to the request,
only to the right order of magnitude.

## The one correctness detail worth building deliberately: atomicity

The obvious naive implementation is two round trips:

```
count = await redis.incr(key)
if (count === 1) await redis.expire(key, windowSeconds)
```

This looks race-free at first glance — and for the "two concurrent
requests both see count===1" case, it actually is: `INCR` is atomic, so
exactly one caller will ever observe the value transition from 0 to 1.
The real bug is narrower and easy to miss: if the process (or the Redis
connection) dies in the gap between the `INCR` resolving and the
`EXPIRE` call landing, the key survives forever with **no TTL at all** —
silently rate-limiting that IP permanently, with no self-healing, until
someone manually notices and runs a `DEL`. `consumeRateLimit` avoids this
by running both commands as one Lua script (`EVAL`), so from Redis's
perspective they're a single atomic step: either both ran, or (on a
connection failure) neither did.

## Fail-open, not fail-closed

If Redis is unreachable, `consumeRateLimit` returns `{ allowed: true,
... }` rather than throwing. Consistent with this project's existing
split (`docs/redis.md`): cache/counter/lock-style Redis usage fails open,
session lookups fail closed. A rate limiter is a defense-in-depth
measure sitting in front of business logic that has its own, independent
correctness guarantees (bcrypt comparison, the OTP attempt cap, the
seat-locking unique index) — it should never be the reason a transient
Redis blip takes down login or registration entirely. The cost of that
choice is real but bounded: during a Redis outage, abuse protection on
these four routes is temporarily off, not that the routes themselves
fail.

## Per-endpoint budgets, not one global number

`packages/shared/src/constants/rate-limit.ts` gives each protected route
its own bucket, because "how many requests per minute is normal" is
different for each of them:

| Bucket | Limit | Window | Keyed by |
|---|---|---|---|
| `login` | 10 | 60s | IP |
| `register` | 5 | 60s | IP |
| `resend-otp` | 5 | 60s | IP |
| `verify-otp` | 20 | 60s | IP |

`resend-otp`'s bucket is deliberately **in addition to**, not a
replacement for, `OTP_RESEND_COOLDOWN_SECONDS` (`constants/auth.ts`):
the cooldown is per-*user* (stops spamming one inbox); this bucket is
per-*IP* (stops one caller from cycling through many different emails).
Similarly, `verify-otp`'s limit of 20/min is wider than
`OTP_MAX_ATTEMPTS` (5, per OTP) on purpose — the per-OTP cap already
locks out any single code well before 20 guesses; this bucket is the
outer guard against an attacker rotating through many different
`(email, guess)` pairs from one IP faster than any single OTP's own
attempt counter would ever see.

## Why IP, not the authenticated user

All four protected routes are ones a caller hits **before** having a
session — there's no user identity yet to key on. `request.ip` is only
trustworthy here because `app.ts` sets `trustProxy: true`; without it,
every request arriving through Nginx would report Nginx's own container
IP, and every real caller behind it would share a single bucket.

## What Phase 8 deliberately does not include

- **A global, all-routes rate limit.** Only the four auth routes above
  are protected. A blanket per-IP cap across the entire API is a
  reasonable production addition, but nothing in this project yet has an
  abuse profile that calls for it — adding it now would be exactly the
  speculative complexity section 58 warns against.
- **Per-user (post-auth) rate limiting** — e.g. capping how many
  reservations one logged-in account can attempt per minute. That's a
  business rule for Phase 9's seat-reservation flow to define, not a
  generic infrastructure concern this phase should guess at.
- **A distributed sliding-window or token-bucket implementation.** Noted
  above as the more precise alternatives; not needed yet, and easy to
  swap in later since `consumeRateLimit` is the only place the algorithm
  lives.
