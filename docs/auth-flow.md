# Authentication (Phase 4)

Covers registration, OTP verification, login, sessions, and logout —
sections 2 and 21 of the project brief — plus the two pieces of
infrastructure this phase pulled forward ahead of their "official" phase
number: a minimal `@flashsale/redis` and a single BullMQ queue.

## Why Redis and BullMQ appear in "the auth phase"

The project's phase list puts Redis fundamentals at Phase 7 and BullMQ at
Phase 12. Auth genuinely can't wait that long: OTP storage and sessions
are Redis by design (section 21), and section 2's flow explicitly routes
OTP delivery through a background job. Rather than either violate the
phase order or build the full Redis/BullMQ story early, both were scoped
down to exactly what auth needs:

- `@flashsale/redis`: a client singleton, a BullMQ-specific connection,
  and two key builders (`otp`, `session`). Phase 7 adds List/Set/SortedSet
  and the full "why this structure, what happens under concurrency, what
  happens on restart" documentation pass for every Redis feature.
- One queue (`emailQueue`), one job type (send OTP email), one fake
  provider (`ConsoleEmailProvider`). Phase 12 adds the remaining queues
  and the retry/backoff/DLQ tuning documentation.

## Registration flow

```
POST /api/v1/auth/register
  ↓
Zod validation (email, password ≥ 8 chars)
  ↓
bcrypt.hash(password)
  ↓
createOrReclaimUnverifiedUser(email, hash)   -- see below
  ↓
issueOtp(redis, userId)                      -- SET NX cooldown, then HSET+EXPIRE
  ↓
Notification row created (status: PENDING)
  ↓
emailQueue.add('send-otp-email', {...})
  ↓
201 { userId }
```

### Registration doesn't permanently squat emails

`createOrReclaimUnverifiedUser` (`auth.repository.ts`) has a deliberate
asymmetry: a request to register an email that belongs to an **verified**
account is a hard conflict (409) — someone already owns it. A request for
an email that belongs to an **unverified** account overwrites the
password hash and reissues an OTP instead of rejecting.

Without this, registering with someone else's email and never verifying
it would permanently block the real owner from ever registering, since
Postgres's `email` unique constraint would otherwise stand in their way
forever. The trade-off: anyone can "retake" an email up until it's
verified. Given the alternative is permanent squatting, this is the
correct default — and it's also why login independently checks
`emailVerifiedAt` before issuing a session, so an unverified reclaim can't
be used to log in as someone else's still-pending registration.

## OTP: hashing choice and brute-force protection

`otp.ts` stores `SHA-256(otp)` in Redis, **not** a bcrypt hash. This is a
deliberate choice, not an oversight: bcrypt's entire value proposition is
being slow, which matters for passwords (no other rate limit exists on
guessing one) but not for a 6-digit OTP, which already has two
independent, much stronger defenses:

1. **`OTP_MAX_ATTEMPTS` (5)** — the code is deleted after 5 wrong guesses,
   not just left to expire.
2. **`OTP_TTL_SECONDS` (300)** — worthless after 5 minutes regardless.

Comparison uses `timingSafeEqual`, not `===` — the property that actually
matters here is resistance to timing attacks, not the hash function's
computational cost.

A resend cooldown (`OTP_RESEND_COOLDOWN_SECONDS`, 60s) is enforced with
`SET key val EX 60 NX` — the atomicity matters: without `NX`, two
concurrent resend requests could both observe "no cooldown yet" and both
issue a code, defeating the cooldown entirely. A fresh send/resend
**replaces** any in-flight code and resets the attempt counter, rather
than adding a second simultaneously-valid code — resending means "start
over," not "now there are two ways in."

## Login and sessions

```
POST /api/v1/auth/login
  ↓
findUserByEmail  (generic "invalid email or password" either way --
                   distinguishing the two would let an attacker
                   enumerate registered emails)
  ↓
bcrypt.compare(password, user.passwordHash)
  ↓
require emailVerifiedAt
  ↓
createSession(redis, {...})
  │
  ├─→ Redis: HSET session:{id} {userId, role, createdAt, lastActivityAt}
  │           + EXPIRE SESSION_TTL_SECONDS (7 days)      -- the fast path
  │
  └─→ Postgres: Session row {id, userId, userAgent, ipAddress, expiresAt}
                                                            -- the audit/index
  ↓
Set-Cookie: flashsale_sid=<sessionId>; HttpOnly; SameSite=Lax; Secure (prod only); Signed
  ↓
200 { user }
```

### Why a Postgres `Session` table when Redis already has the session

These aren't duplicates — they're written at completely different
frequencies for different purposes. See `docs/database.md`'s "Why there's
a Session table" section for the full reasoning; the short version:
Redis is the fast-path lookup hit on every authenticated request; the
Postgres row is a low-frequency audit/revocation index (written once at
login, once at logout) so "sign out of all devices" and admin visibility
don't require `SCAN`-ing Redis's keyspace.

### `lastActivityAt` is throttled, not written every request

`touchSessionIfStale` (`session.ts`) only writes `lastActivityAt` back to
Redis if the existing value is more than `SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS`
(60s) stale. Without this, every single authenticated request would cost
a Redis write purely to bump a timestamp nothing consumes at
sub-minute granularity — needlessly doubling this app's Redis write
volume. It's also fire-and-forget from `requireAuth`'s perspective: a
failure to refresh the activity timestamp must never fail the request
it's piggybacking on.

### Sessions are a fixed-lifetime TTL, not a sliding idle timeout

A session's Redis TTL is set once at creation (`SESSION_TTL_SECONDS`, 7
days) and is **not** extended on activity. A user active every day for
six days gets logged out on day 7 regardless. This was a deliberate scope
decision for Phase 4: a sliding-expiration session (extend TTL on every
touch) is a reasonable thing to want, but it means every authenticated
request needs to reason about "should this also push the expiry
forward," which interacts with the activity-touch throttle above in ways
worth designing carefully rather than bolting on. Fixed-lifetime is the
simpler, still-correct starting point; sliding expiration is a candidate
enhancement, not implemented here.

## The auth hook: opt-in, not global

`requireAuth` (`plugins/auth-hook.ts`) is a `preHandler`, applied per
route (`{ preHandler: requireAuth }`) — not a global `onRequest` hook
applied to every request. Section 21's flow — cookie → Redis
`session:{sessionId}` → userId → Postgres if needed — stops at Redis for
routes that only need `userId`/`role`; the Postgres lookup only happens
where a route genuinely needs full user data (`GET /me`).

## `/ready` finally does real work

Phase 1/2/3 left `/ready` stubbed to `not_configured` because no
Postgres/Redis client existed yet. Now that both do, it runs `SELECT 1`
and `PING` with a 2-second timeout each (in parallel), and returns `503`
— not a 200 with a note buried in the body — if either fails, so a load
balancer's health-check-by-status-code configuration does the right
thing without needing to parse the response.

One implementation detail worth calling out because it caused a real test
crash during this phase: `Promise.race([check, timeout])` does **not**
attach a rejection handler to the check if it loses the race. If the real
check later rejects (a slow Postgres that eventually errors after the
2-second window already elapsed), Node treats that as an unhandled
rejection and crashes the process — including in production, not just in
tests. The fix (`withTimeout` in `health.routes.ts`) attaches a no-op
`.catch()` to the original promise unconditionally, so it's always
observed regardless of which side of the race "wins."

## Logout

```
POST /api/v1/auth/logout   (requires a valid session)
  ↓
Redis: DEL session:{id}          -- ends the session immediately
Postgres: Session.revokedAt = now()   -- audit trail: revoked, not expired
  ↓
Clear-Cookie
  ↓
200 { loggedOut: true }
```

## What Phase 4 deliberately does not include

- **Rate limiting on login** — section 20/Phase 8's job. Brute-forcing
  login attempts is currently unmitigated beyond the OTP-gate on
  verification; this is a known, deliberate gap until Phase 8.
- **Sliding session expiration** — see above.
- **A real email provider** — `ConsoleEmailProvider` logs instead of
  sending. Swapping it for SES/Postmark/etc. is a Phase 12+ concern.
- **CSRF protection beyond `SameSite=Lax`** — Phase 20's security
  hardening pass revisits this alongside the rest of section 46.
