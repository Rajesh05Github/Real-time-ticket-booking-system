# Phase 20 — Production Hardening

Four independent gaps this project's own docs had been flagging as
deferred since as early as Phase 3/4/18/19, closed together as one
hardening pass: CSRF protection, secrets management, a worker health
endpoint, and the connection-pool bottleneck Phase 18's load test found.
Plus a fifth, unplanned one: Nginx TLS termination, added because live
testing the CSRF change surfaced a real, concrete reason it couldn't wait
for Phase 21.

## 1. CSRF protection (a signed double-submit cookie)

`docs/auth-flow.md` flagged this back in Phase 4: "CSRF protection beyond
`SameSite=Lax`." SameSite=Lax already blocks the primary attack vector for
a JSON API consumed via `fetch`/XHR (cross-origin fetch/XHR requests don't
carry Lax cookies at all, regardless of method) -- this is genuine
defense IN DEPTH, not closing an actively-exploited hole, and this
project's own `apps/web` doesn't yet have a real authenticated UI to have
exploited it through anyway. Still worth building for real: any actual
client integration needs it, and it's explicitly named as Phase 20 scope.

**The mechanism** (`apps/api/src/plugins/csrf.ts`): a signed double-submit
cookie, not a naive one. `POST /login` issues a second, non-`HttpOnly`
cookie (`flashsale_csrf`) alongside the session cookie, whose value is
`HMAC-SHA256(COOKIE_SECRET, sessionId)` -- deterministic, so there's no
server-side storage at all; this server can always recompute what a given
session's token SHOULD be. The frontend reads that cookie (JS can, since
it's not `HttpOnly`) and echoes it back in an `X-CSRF-Token` header on
every mutating request. `requireAuth` verifies, for every non-safe method
(everything except GET/HEAD/OPTIONS), that the header and cookie match
each other AND both equal the expected HMAC for the now-authenticated
session -- using `crypto.timingSafeEqual`, not `===`, so the comparison
itself doesn't leak timing information. A cross-site attacker's page can't
read `flashsale_csrf` (same-origin policy) and can't forge a valid one
(it needs `COOKIE_SECRET`, which only this server has).

**Why `requireAuth`, not a separate preHandler bolted onto every mutating
route:** every state-changing endpoint in this API already requires
`requireAuth`; folding the check in there means zero route files needed
touching. `optionalAuth` deliberately does NOT check it -- its only two
current callers (event listing/detail) are GET routes, where there's
nothing for CSRF to protect.

**Real ripple effect, found and fixed while building this:** three test
surfaces create sessions directly (bypassing the real `/login` route
entirely) and had to be updated to also issue/send the matching CSRF
token: Phase 17's `reservation-concurrency.integration.test.ts`, and
Phase 18's `provision-sessions.mjs` + `seat-reservation.js`. Each now uses
the exact same HMAC formula (either via the real `setCsrfCookie` helper,
or an inlined duplicate matching the existing precedent for why
`createSession`'s logic is duplicated in the load-test script). Re-run
and verified clean: the Phase 17 integration test passes, and a full k6
run against the live stack showed 100% of requests correctly
authenticated (no unexpected 403s from a missing/wrong token).

**Live-verified end to end** against the real HTTPS stack (see section 5):
a mutating request with no `X-CSRF-Token` header gets
`403 CSRF_VALIDATION_FAILED`; the same request with the correct token
(read back from the login response's `Set-Cookie`) succeeds; `GET /me`
needs no token at all.

## 2. Secrets management: no more committed fallback defaults

Before this phase, `docker-compose.yml` had THREE different plaintext
secrets baked directly into a tracked file: `POSTGRES_PASSWORD: flashsale`
(hardcoded, no override at all) and `COOKIE_SECRET`/`PAYMENT_WEBHOOK_SECRET`
with `${VAR:-a-well-known-committed-default}` fallbacks. Anyone who ever
clones this repo and runs `docker compose up` without a `.env` gets the
exact same, publicly-visible secret every other clone does -- and worse,
`.env`'s absence fails SILENTLY (Compose just falls back).

**Fixed:** all three now use `${VAR:?VAR must be set -- see .env.example}`
-- no fallback, and a clear, immediate failure (not a silently-empty
substitution) if `.env` doesn't supply one. `POSTGRES_PASSWORD` moved
from a hardcoded literal to `.env` (gitignored, per-developer/
per-environment) for the first time. Local dev is unaffected -- `.env`
already had real values for the other two, and now has one for
`POSTGRES_PASSWORD` too -- but a deployment that forgets to inject these
now fails loudly at `docker compose up` instead of quietly running
insecurely. Phase 21's AWS deployment pulls the real production
equivalents from a secrets manager (Secrets Manager / SSM Parameter
Store) instead of a `.env` file at all -- this phase's fix is what makes
that swap-in clean (no committed value competing with it).

## 3. A worker health endpoint (there was none)

`worker.Dockerfile` and `apps/worker/src/env.ts` both explicitly flagged
this gap since Phase 2/4: "the worker has no HTTP surface... Phase 20 may
add a tiny metrics/health port." Before this phase, `docker ps` could only
tell you the container hadn't exited -- nothing could ask "is this
process actually alive and responsive."

**Built:** `health-server.ts`, a plain `node:http` server (not Fastify --
one static-response endpoint doesn't justify a whole framework
dependency) answering `GET /health` with `{"status":"ok"}`. Deliberately
LIVENESS-only, not a `/ready` pinging Postgres/Redis the way apps/api's
does: Phase 19's failure testing already confirmed a Postgres/Redis
outage degrades this process gracefully (log-and-retry each tick)
without crashing it, so there's no dependency-driven "take me out of
rotation" signal worth building yet. Wired into the SAME graceful-
shutdown discipline every other worker resource follows -- registered
LAST (closes FIRST, signaling "going away" to any external health check
as early as possible) in `register-shutdown-hooks.ts`, with its own
regression test.

**Live-verified:** `docker ps` now shows `flashsale-worker-1 (healthy)`
for the first time in this project's history. A `docker stop` showed
`"health server stopped"` logged first, `handlerCount: 9`, clean shutdown
well under a second -- consistent with every prior phase's shutdown
verification.

## 4. The connection-pool bottleneck Phase 18 found

`docs/load-testing.md` measured this precisely: `DATABASE_URL` carried no
`connection_limit`, so Prisma's pool defaulted to `num_cpus*2+1` -- a
single small pool shared by every concurrent request through one `api`
container, driving p95 latency up under load (~920ms hot-seat / ~2.28s
general-throughput at 150 concurrent VUs).

**Fixed:** `?connection_limit=20` on `api`'s `DATABASE_URL`,
`?connection_limit=10` on `worker`'s (smaller, since the worker's Prisma
usage is periodic ticks and BullMQ job processing, not request-path
traffic scaling with concurrent HTTP connections) -- both comfortably
within Postgres's own `max_connections` (100 by default), leaving
headroom for both processes plus any direct/admin connections.

**Re-verified with the exact same k6 script Phase 18 built:** p95 latency
dropped from ~920ms to **354ms** (hot-seat) and ~2.28s to **623ms**
(general-throughput) at the same 150 concurrent VUs -- a real, measured
improvement directly attributable to this one query-parameter change,
not a guess. Correctness was unaffected either way: exactly 303
successful reservations (matching the seat pool size) in both the
Phase 18 and Phase 20 runs.

**What's still deliberately NOT done:** raising `max_connections` itself,
or fronting Postgres with a real pooler (PgBouncer) for connection reuse
across MULTIPLE api replicas -- this project runs exactly one `api`
container, so per-process pool tuning was the correct-sized fix; a
pooler matters once there's more than one process sharing one Postgres.
That's a Phase 21 (AWS, likely multiple replicas) concern.

## 5. Nginx TLS termination (moved up from "maybe Phase 21")

**Why this wasn't just deferred again:** verifying CSRF live (section 1)
surfaced a real, concrete problem. The session cookie (since Phase 4) and
the new CSRF cookie are both marked `Secure` whenever `NODE_ENV=production`
-- which this entire `docker-compose.yml` stack runs with, specifically
to test the real production Dockerfiles. But this stack had NO TLS
anywhere. A `Secure` cookie is silently DROPPED by any real browser sent
over plain HTTP -- meaning a real browser hitting this "production"
stack's front door would have had a completely broken login, undetected
throughout Phases 4-19 because every verification step used `curl`,
which doesn't enforce the `Secure` flag the way a browser does. This was
a latent bug the whole time, only surfaced now because Phase 20 happened
to test cookie behavior more carefully than any prior phase needed to.

**Built:** `infra/nginx/generate-dev-cert.sh` (idempotent self-signed
cert generation, LOCAL DEVELOPMENT SIMPLIFICATION -- a real CA-issued
certificate needs a real, publicly-resolvable domain, which `localhost`
isn't), run once by a new one-shot `nginx-cert-init` service into a
shared `nginx_certs` volume before `nginx` starts
(`condition: service_completed_successfully`). `nginx.conf` gained a real
`443 ssl` server block and turned the existing port-80 block into a
redirect to it (`/health` excepted -- a container healthcheck has no
reason to negotiate TLS).

**Live-verified:** `http://localhost:8080/` returns a `301` to
`https://localhost:8443/`; `https://localhost:8443/health` returns `200`
(self-signed, `curl -k`); a full login through the HTTPS front door sets
both cookies correctly; the complete CSRF round-trip (missing token ->
403, correct token -> 201) was re-verified through this real HTTPS path,
not just against the API container directly.

**What this is NOT:** a preview of Phase 21's exact AWS topology. A real
deployment terminating TLS with an ACM-issued certificate would most
plausibly do so at an Application Load Balancer, not Nginx -- this
demonstrates the TERMINATION MECHANISM (and fixes the concrete `Secure`
-cookie bug above) for the local stack, not a rehearsal of exactly how
Phase 21 will be wired.

## What Phase 20 deliberately does not include

- **Raising Postgres's `max_connections` or adding PgBouncer.** Covered
  above -- the right-sized fix for one `api` replica was per-process pool
  tuning; a pooler matters once there's more than one.
- **A worker `/ready` that pings dependencies.** No current reason to
  take the worker "out of rotation" for anything -- it isn't behind a
  load balancer distributing requests across replicas the way `api` is.
- **Real TLS via a public CA.** Requires a real domain; Phase 21's AWS
  deployment is the natural place for that (ACM + a real domain name).
- **Rate-limiting or authenticating the new worker health port.** It
  returns a static, non-sensitive `{"status":"ok"}` -- there's nothing to
  protect and no cost to a health check hitting it repeatedly.
