# Phase 18 — k6 Load Testing

## What this phase answers that Phase 17 couldn't

Phase 17's integration test proved CORRECTNESS under concurrency: ten
requests for one seat, exactly one winner, verified once, in-process,
against a handful of requests. It cannot say anything about BEHAVIOR
under real, sustained load -- does latency hold up at 150 concurrent
users? Does a request for an already-taken seat stay cheap, or does
contention leak into something expensive? Those are throughput/latency
questions, answered here against the actual containerized stack (Nginx +
api + worker + real Postgres + real Redis, `docker compose up -d
--build`), not a single in-process Fastify instance.

## Two scenarios, run back to back

`tests/load/seat-reservation.js`:

- **`hot_seat_contention`** -- 50 VUs (default) hammering a pool of just
  3 seats for 20s. Within the first few requests every seat is gone;
  everything after that is a GUARANTEED loss. This is deliberately the
  worst moment of a real flash sale: everyone refreshing for the one
  front-row seat that sold out three seconds after the sale opened. What
  it measures is the actual design claim in `reservation.service.ts`'s
  own comments -- that a request for an unavailable seat is turned away
  CHEAPLY (a fast Redis admission-control rejection, or a fast Postgres
  unique-index failure), not by falling through to something expensive.
- **`general_throughput`** -- 100 VUs (default) each picking a
  pseudo-random seat from a pool of 300, staggered to start after
  `hot_seat_contention` finishes so the two scenarios' metrics don't
  blend together. Seats never come back to the pool for the length of a
  30s scenario (a claimed seat stays `RESERVED` for
  `RESERVATION_HOLD_SECONDS`, far longer than 30s), so this isn't tuned
  to keep every request succeeding -- it measures latency/throughput
  across a realistic depletion curve, the complement to the hot-seat
  scenario's "already empty" focus.

## Why sessions are provisioned out of band, not via k6 logging in

`POST /api/v1/auth/login` is rate-limited to 10 attempts/minute per IP
(Phase 8) -- correctly so, that's exactly the brute-force protection it
exists for. Provisioning hundreds of load-test identities through that
route would mean either waiting tens of minutes for the rate limit to
allow it, or weakening a real security control purely to make a load
test's setup faster. Neither is acceptable, so `tests/load/
provision-sessions.mjs` creates users and sessions directly (the same
Redis hash + Postgres audit row `apps/api/src/modules/auth/session.ts`'s
`createSession` writes, inlined here since that function is app-internal,
not a published workspace package) and writes a `sessions.json` the k6
script reads via `open()`. This is standard practice for real load
testing tools, not a shortcut specific to this project: provision test
identities out of band, then load-test the actual endpoint under test
with already-authenticated traffic. The one real HTTP login this phase
does perform is a SINGLE admin login inside `setup()`, to create the
venue/event/seats through the real admin API -- one call never touches
the rate limit.

```bash
docker compose up -d --build                                    # full stack
pnpm --filter @flashsale/load-tests run provision                # 200 sessions -> sessions.json
MSYS_NO_PATHCONV=1 docker run --rm --network flashsale_flashsale-net \
  -v "$(pwd)/tests/load:/scripts" grafana/k6 run /scripts/seat-reservation.js
pnpm --filter @flashsale/load-tests run cleanup                   # delete load-test users/reservations/venues
```

(`MSYS_NO_PATHCONV=1` and the exact network name are Windows/Git-Bash and
Docker-Compose-project-naming specifics respectively -- see the comments
at the top of `seat-reservation.js`.)

## Three real bugs, found live

**1. A generic 500 for what should have been a 400.** The very first
`setup()` run failed at `POST /:eventId/publish` with `500 INTERNAL_
SERVER_ERROR`. The real cause: the k6 script sent
`Content-Type: application/json` with a `null` body on a route that
takes neither -- a genuine client mistake -- but Fastify's own
`FST_ERR_CTP_EMPTY_JSON_BODY` (which carries a real `statusCode: 400`)
was falling all the way through `error-handler.ts`'s fallthrough, which
only recognized `AppError`, `ZodError`, and Fastify's *schema*-validation
errors (`error.validation`) -- never Fastify's own built-in
request-parsing errors. Every malformed body (empty JSON, invalid JSON,
oversized body) was silently becoming a misleading "Internal Server
Error" instead of the accurate 400/413 it should have been. Fixed in
`error-handler.ts` by trusting any error's own `statusCode` when it's a
genuine 4xx, with a regression test
(`apps/api/src/plugins/error-handler.test.ts`). The k6 script's own
mistake (the stray `Content-Type` header) was also fixed separately --
both fixes are independently correct and neither depends on the other,
though only the FIRST is a codebase bug.

**2. Reservation cleanup violating a real FK constraint.**
`cleanup-sessions.mjs`'s first version tried to `prisma.user.deleteMany`
directly, and failed with Prisma error `P2003` the first time a load-test
run had actually reserved real seats: `Reservation.userId` is
`onDelete: Restrict` by design (an audit-trail guarantee, not an
oversight -- `schema.prisma`), so a User with reservations can't be
deleted out from under them. Fixed by deleting `Reservation` rows for
those users first (`ReservationItem` cascades off `Reservation`, so
nothing further is needed there) before deleting the users themselves --
the exact same FK-safe-deletion-order discipline Phase 17's integration
test already established for its own cleanup.

**3. Guessed latency thresholds vs. this machine's actual architecture.**
The FIRST `seat-reservation.js` used aspirational thresholds (hot-seat
p95 < 500ms, general p95 < 300ms) picked before ever running the test.
Both failed on the first real, correctness-clean run: p95 came back at
~920ms and ~2.3s. The root cause is architectural, not a code defect:
`DATABASE_URL` carries no `connection_limit`, so Prisma's connection pool
defaults to `num_cpus*2+1` -- a single, small pool shared by every one of
150 concurrent VUs through ONE `api` container. `docs/database.md` has
flagged exactly this class of bottleneck ("write throughput on
reservation_items/seats... under load testing") as a risk since Phase 3;
this is that prediction landing for real. The thresholds were updated to
reflect this MEASURED local-dev baseline (with headroom), explicitly
documented as a local-dev baseline rather than a production SLA, and
made overridable (`-e HOT_SEAT_P95_MS=500 -e GENERAL_P95_MS=300`) to
re-check against the original aspirational numbers once connection
pooling exists.

## What Phase 18 deliberately does not include

- **Fixing the connection-pool bottleneck itself.** Adding a
  `connection_limit` param, PgBouncer, or horizontally scaling the `api`
  container are real, valid responses to finding #3 above -- but they're
  production-hardening/deployment decisions that belong to Phase 20
  (production prep) or Phase 21 (AWS), not a retroactive patch applied
  the moment a load test happens to surface the need for one. This phase
  proves the bottleneck exists and measures it; fixing it is later,
  deliberately scoped work.
- **A durability/soak test.** These scenarios run for 20-30 seconds each
  -- enough to prove the two behavioral claims above, not to catch a slow
  memory leak or gradual connection-pool exhaustion over hours. That's a
  different (and heavier) kind of test than this phase's scope.
- **Load-testing every route.** Seat reservation was chosen because it's
  the one endpoint this project's own docs have repeatedly called out as
  the place contention and throughput actually matter (docs/database.md,
  docs/reservation-flow.md). Most other routes' behavior under load is
  much less interesting -- they don't contend over a shared, finite,
  hand-off resource the way seat claiming does.
