# FLASHSALE

A distributed-systems teaching project built as a production-shaped event
ticket booking platform. See [docs/architecture.md](docs/architecture.md)
for the full system design and [docs/](docs/) for per-topic deep dives.

## Status

**Phase 21 of 21 (final)** — AWS deployment prep: a complete Terraform
config (`infra/terraform/`) provisioning ECS Fargate (api/worker/web),
RDS Postgres, ElastiCache Redis, and an ALB that takes over Phase 20's
Nginx container's exact job (TLS termination + path-based routing) —
validated with `terraform init`/`validate`/`fmt` via the official Docker
image (real AWS-provider schema checking, e.g. it caught that security
group descriptions reject apostrophes), but **deliberately never applied
against a real AWS account** — that scope was chosen explicitly, not
defaulted into. Every Phase 20 finding carries straight through: the
`connection_limit` tuning, the worker health endpoint as an ECS
`healthCheck`, `COOKIE_SECRET` serving both session-signing and CSRF, and
Secrets-Manager-backed secrets with no committed fallbacks. See the phase
list in [docs/architecture.md](docs/architecture.md#phases) and
[docs/aws-deployment.md](docs/aws-deployment.md) for the full
architecture writeup and every deliberate scope decision.

**Post-build hardening:** the checkout lifecycle gaps the phases deferred
(checkout timeout, cancelling mid-checkout, automatic refunds, cancelling
a paid booking, live seat maps, idempotency-key cleanup, a cached public
event list, real email delivery) are now closed -- see
[docs/checkout-lifecycle.md](docs/checkout-lifecycle.md) -- and the app
deploys to Azure Container Apps with CI/CD -- see
[docs/azure-deployment.md](docs/azure-deployment.md).

This closes all 21 phases of the FLASHSALE build. See
[docs/](docs/) for the complete set of per-topic writeups accumulated
along the way.

## Stack

Next.js (App Router) · Node.js/Fastify API · BullMQ worker · PostgreSQL +
Prisma · Redis (cache, sessions, locks, rate limiting, counters, sets,
sorted sets, streams, pub/sub) · Docker Compose · Nginx.

## Monorepo layout

```
apps/
  web/      Next.js application
  api/      Node.js/Fastify API (the source of truth for business logic)
  worker/   BullMQ workers, outbox publisher, Redis Stream consumers
packages/
  database/       Prisma schema, migrations, seed data, client singleton
  redis/           Redis client, key builder, rate limiter, notification feed (OTP/session/cache/feed/watchers/trending/streams; pub/sub in Phase 15+)
  shared/         Cross-cutting types, errors, response envelope, constants
  config/         Zod-validated environment loading
  logger/         Structured JSON logging (Pino)
  eslint-config/  Shared lint rules
infra/            Docker, Nginx, scripts             (Phase 2+)
docs/             Architecture, Redis, streams, flows, testing, deployment
docker-compose.test.yml   Disposable Postgres/Redis for integration tests (Phase 17)
tests/
  load/           k6 load-test scripts + session provisioning (Phase 18)
```

*Real concurrency tests landed in Phase 17 as `apps/api/src/**/*.integration.test.ts`
(run via `pnpm test:integration`), not under `tests/` -- see
[docs/testing.md](docs/testing.md). `tests/load` is deliberately a
SEPARATE, language/tool-agnostic top-level workspace package rather than
living inside `apps/api`: a k6 script runs in k6's own JS runtime, not
Node/TypeScript, and isn't wired into the standard build/lint/typecheck
pipeline (see [docs/load-testing.md](docs/load-testing.md)).

## Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable` will provide it)
- Docker Desktop (from Phase 2 onward)

## Getting started

```bash
pnpm install
cp .env.example .env
# edit .env - at minimum set a real COOKIE_SECRET

docker compose up -d postgres redis   # stateful dependencies only
pnpm --filter @flashsale/database migrate:deploy   # apply migrations
pnpm --filter @flashsale/database seed             # idempotent — safe to re-run

pnpm dev                               # api/worker/web on the host, hot-reload
```

This starts:

- `apps/web` on http://localhost:3000
- `apps/api` on http://localhost:4000
- `apps/worker` (no HTTP port; logs to stdout)
- Postgres on `localhost:5435` and Redis on `localhost:6380` (non-standard
  host ports — see [docs/deployment.md](docs/deployment.md) for why)

Seeded accounts: `admin@flashsale.dev` / `fan@flashsale.dev`, both with
password `Password123!` (local dev only — see
[docs/database.md](docs/database.md)).

`/ready` now does real work (`SELECT 1` + `PING`, 2s timeout each) since
apps/api depends on `@flashsale/database`/`@flashsale/redis` as of Phase
4 — it returns 503 if either is unreachable. `/health` (liveness) still
always returns 200 because it deliberately never depends on downstream
services. See
[apps/api/src/modules/health/health.routes.ts](apps/api/src/modules/health/health.routes.ts).

### Trying the auth flow

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correcthorse"}'
# apps/worker's logs show the OTP (ConsoleEmailProvider -- see docs/auth-flow.md)

curl -X POST http://localhost:4000/api/v1/auth/verify-otp \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","otp":"123456"}'

curl -c cookies.txt -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correcthorse"}'

curl -b cookies.txt http://localhost:4000/api/v1/me
curl -b cookies.txt -X POST http://localhost:4000/api/v1/auth/logout
```

### Trying the admin flow

Log in as `admin@flashsale.dev` first (see above), then:

```bash
curl -c admin.txt -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@flashsale.dev","password":"Password123!"}'

VENUE_ID=$(curl -s -b admin.txt -X POST http://localhost:4000/api/v1/venues \
  -H 'Content-Type: application/json' -d '{"name":"My Arena"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

SECTION_ID=$(curl -s -b admin.txt -X POST "http://localhost:4000/api/v1/venues/$VENUE_ID/sections" \
  -H 'Content-Type: application/json' -d '{"name":"A"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

EVENT_ID=$(curl -s -b admin.txt -X POST http://localhost:4000/api/v1/events \
  -H 'Content-Type: application/json' \
  -d "{\"venueId\":\"$VENUE_ID\",\"name\":\"My Event\",\"startTime\":\"2026-12-01T14:00:00.000Z\"}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -b admin.txt -X POST "http://localhost:4000/api/v1/events/$EVENT_ID/seats" \
  -H 'Content-Type: application/json' \
  -d "{\"assignments\":[{\"sectionId\":\"$SECTION_ID\",\"seatCodePrefix\":\"A\",\"startNumber\":1,\"seatCount\":50,\"priceMinor\":100000,\"currency\":\"INR\"}]}"

curl -b admin.txt -X POST "http://localhost:4000/api/v1/events/$EVENT_ID/publish"
curl "http://localhost:4000/api/v1/events/$EVENT_ID"   # now visible without auth
```

A request for 200+ total seats returns `202` with a `jobId` instead of
creating them inline — see [docs/admin-flow.md](docs/admin-flow.md) for
why, and poll `GET
/api/v1/events/:eventId/seats/generation-jobs/:jobId` for progress.

### Trying event browsing + caching

```bash
curl "http://localhost:4000/api/v1/events?search=India&page=1&pageSize=10"

# First request populates cache:event:{id} in Redis (TTL 300s); repeat
# it and it's served from Redis, not Postgres, until an admin write
# invalidates it or the TTL elapses -- see docs/event-browsing.md for
# how this was verified live, including tampering with the cached value
# directly to prove the hit path is real.
curl "http://localhost:4000/api/v1/events/$EVENT_ID"
```

### Trying event engagement + notifications

```bash
# Watching an event (Set) -- requires a logged-in fan; see the auth flow above
curl -b cookies.txt -X POST "http://localhost:4000/api/v1/events/$EVENT_ID/watch"
curl -b cookies.txt "http://localhost:4000/api/v1/events/$EVENT_ID/watch"   # { isWatching: true, watcherCount: 1 }
curl -b cookies.txt -X DELETE "http://localhost:4000/api/v1/events/$EVENT_ID/watch"

# Each public detail view increments a Redis counter and a trending
# Sorted Set score (admin views are excluded -- see docs/redis.md)
curl "http://localhost:4000/api/v1/events/$EVENT_ID" > /dev/null
curl "http://localhost:4000/api/v1/events/trending?limit=5"

# The notification feed (List) -- every OTP email also pushes an entry
# here, newest first, capped at 50
curl -b cookies.txt http://localhost:4000/api/v1/notifications
```

See [docs/redis.md](docs/redis.md) for the full key registry and the
String/Hash/List/Set/Sorted-Set comparison table.

### Trying rate limiting

```bash
# The login route allows 10 attempts/minute per IP -- the 11th in the
# same window gets a 429 with a Retry-After header, not a 401
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "attempt $i -> %{http_code}\n" \
    -X POST http://localhost:4000/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"nobody@example.com","password":"wrong"}'
done

curl -i -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"wrong"}'
# HTTP/1.1 429 Too Many Requests
# retry-after: <seconds until the window resets>
# {"success":false,"error":{"code":"RATE_LIMIT_EXCEEDED", ...}}
```

Each protected route (register/login/resend-otp/verify-otp) has its own
independent budget — see [docs/rate-limiting.md](docs/rate-limiting.md)
for the full table and why a fixed window (not a sliding window or token
bucket) was the right choice here.

### Trying seat reservation

```bash
# Log in as the seeded fan (see the auth flow above for register/verify)
curl -c fan.txt -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"fan@flashsale.dev","password":"Password123!"}'

# Idempotency-Key is REQUIRED -- omitting it is a 400, not a convenience
curl -i -b fan.txt -X POST http://localhost:4000/api/v1/reservations \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-attempt-1' \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID_1\",\"$SEAT_ID_2\"]}"

# Retrying the EXACT same key+body replays the original response verbatim
# -- the route handler does not run a second time
curl -b fan.txt -X POST http://localhost:4000/api/v1/reservations \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-attempt-1' \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID_1\",\"$SEAT_ID_2\"]}"

curl -b fan.txt http://localhost:4000/api/v1/reservations           # list mine
curl -b fan.txt -X DELETE "http://localhost:4000/api/v1/reservations/$RESERVATION_ID"
```

Ten truly concurrent requests for the same seat produce exactly one
`201` and nine `409 SEAT_NOT_AVAILABLE` — enforced by a Postgres partial
unique index, not the Redis lock, which only reduces contention. See
[docs/reservation-flow.md](docs/reservation-flow.md) for the full design
and a real Fastify bug (`onSend` doing async I/O) found live while
building the idempotency layer.

### Trying the transactional outbox

```bash
# Create (or cancel) a reservation as above, then watch it flow through:
docker exec flashsale-postgres-1 psql -U flashsale -d flashsale -c \
  "SELECT aggregate_id, event_type, status FROM outbox_events ORDER BY created_at DESC LIMIT 5;"

# Within OUTBOX_PUBLISH_INTERVAL_MS (5s) the worker flips PENDING -> PUBLISHED
# and XADDs an entry -- confirm it landed in the stream:
docker exec flashsale-redis-1 redis-cli XLEN stream:domain-events
docker exec flashsale-redis-1 redis-cli XREVRANGE stream:domain-events + - COUNT 1
```

The business write (reservation created/cancelled/expired) and the
outbox row announcing it are written in ONE transaction — see
[docs/outbox.md](docs/outbox.md) for why that's what actually closes the
dual-write gap, why this is a Redis Stream and not Pub/Sub, and what
"at-least-once, not exactly-once" delivery means for the consumer below.

### Trying the Streams consumer

```bash
# Create/cancel a reservation as above, then within ~10s (one outbox
# publish tick + one consumer BLOCK cycle) it shows up in your feed:
curl -b fan.txt http://localhost:4000/api/v1/notifications

# The consumer group's own bookkeeping:
docker exec flashsale-redis-1 redis-cli XINFO GROUPS stream:domain-events
docker exec flashsale-postgres-1 psql -U flashsale -d flashsale -c \
  "SELECT consumer_group, event_id, processed_at FROM processed_events ORDER BY processed_at DESC LIMIT 5;"
```

`pending` in `XINFO GROUPS` should settle back to 0 shortly after each
new entry — a nonzero, growing `pending` count would mean the consumer
is stuck or crashing before `XACK`. See
[docs/streams.md](docs/streams.md) for consumer groups, why dedup keys
on `outboxId` and not the Redis-generated stream ID, and how
`XAUTOCLAIM` recovers a crashed consumer's in-flight messages.

### Trying BullMQ retry/backoff and the expiry race

```bash
# Create a reservation, then inspect the delayed job it schedules:
docker exec flashsale-redis-1 redis-cli ZRANGE bull:reservationExpiryQueue:delayed 0 -1 WITHSCORES
docker exec flashsale-redis-1 redis-cli HGETALL bull:reservationExpiryQueue:1
# -> opts shows { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ... }

# The bounded failed-job set (this project's DLQ, not a separate queue):
docker exec flashsale-redis-1 redis-cli LRANGE bull:emailQueue:failed 0 -1
```

Whichever fires first between this delayed job and the Postgres sweeper
(Phase 9) wins; the other silently no-ops via the same `releaseReservation`
guard both call — see [docs/queues.md](docs/queues.md) for the retry
policy per queue and the real "zero retries since Phase 4" gap this
phase closed.

### Trying the payment flow

```bash
# Reserve a seat and create an order (see the reservation flow above for
# how to get an EVENT_ID/SEAT_ID) -- both routes need an Idempotency-Key:
curl -b fan.txt -X POST http://localhost:4000/api/v1/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: order-1' \
  -d "{\"reservationId\":\"$RESERVATION_ID\"}"
# -> amountMinor arrives as a STRING ("500000"), not a native number --
#    bigint can't survive JSON.stringify otherwise.

# Immediately after, the reservation is PENDING_PAYMENT, not CONFIRMED --
# confirmation is genuinely asynchronous (PAYMENT_MOCK_CONFIRM_DELAY_MS,
# 3s) via the SAME webhook route a real provider would call:
curl -b fan.txt http://localhost:4000/api/v1/reservations/$RESERVATION_ID

# Simulate the provider declining the charge yourself (like Stripe's own
# CLI trigger command) instead of waiting for the mock's own success:
curl -X POST http://localhost:4000/api/v1/payments/webhook \
  -H 'Content-Type: application/json' \
  -H "x-payment-webhook-secret: $PAYMENT_WEBHOOK_SECRET" \
  -d "{\"providerRef\":\"$PROVIDER_REF\",\"outcome\":\"failed\"}"

# Order stays PENDING (retryable) -- start a second Payment attempt:
curl -b fan.txt -X POST http://localhost:4000/api/v1/orders/$ORDER_ID/retry-payment \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: retry-1' -d '{}'
```

See [docs/payment-flow.md](docs/payment-flow.md) for why the webhook is
real (not a same-request illusion), why order creation needs no Redis
lock unlike seat reservation, and the `Payment.providerRef` uniqueness
gap this phase found and fixed.

### Trying tickets

```bash
# Immediately after creating an order, tickets is empty:
curl -b fan.txt http://localhost:4000/api/v1/orders/$ORDER_ID | grep -o '"tickets":\[[^]]*\]'

# A few seconds later (after the mock provider's webhook confirms), the
# same order shows one Ticket per seat:
curl -b fan.txt http://localhost:4000/api/v1/orders/$ORDER_ID

curl -b fan.txt http://localhost:4000/api/v1/tickets            # list mine
curl -b fan.txt http://localhost:4000/api/v1/tickets/$TICKET_ID  # includes full event + seat details
```

See [docs/tickets.md](docs/tickets.md) for why issuance is wired
directly into the payment-success transaction rather than a queued job,
the collision-resistant ticket number format, and a real schema bug
(`Ticket.seatId` had no relation at all) found live by this phase.

### Trying the live viewer presence

```bash
# Requires a WebSocket client, e.g. this repo has no browser UI for it yet.
# In Node.js (18+), from two separate terminals:
node -e "
const ws = new WebSocket('ws://localhost:4000/api/v1/events/$EVENT_ID/live');
ws.onmessage = (e) => console.log(e.data);
"
```

Open it in a second terminal while the first is still connected and both
receive the updated `{"type":"viewerCount","count":2}` — proving the
broadcast fans out across independent WebSocket connections through one
shared Redis subscriber, not a per-client one. Closing either connection
broadcasts the decremented count to whoever's left. See
[docs/pubsub.md](docs/pubsub.md) for why Pub/Sub (not Streams or a queue)
is the right tool here, the dedicated-subscriber-connection requirement,
and the deliberately deferred live seat-map broadcasting feature.

### Trying analytics

```bash
# Drive a full reservation -> order -> payment flow (see the sections
# above), then, logged in as admin:
curl -b admin.txt http://localhost:4000/api/v1/analytics/summary
# -> { "eventCounts": { "order.paid": "5", ... }, "revenueMinorByCurrency": { "INR": "500000" } }

# A non-admin session gets 403, same adminOnly pattern as venues/events.
curl -i -b fan.txt http://localhost:4000/api/v1/analytics/summary

# Both consumer groups reading the SAME stream, completely independently:
docker exec flashsale-redis-1 redis-cli XINFO GROUPS stream:domain-events
docker exec flashsale-redis-1 redis-cli HGETALL analytics:eventCounts
docker exec flashsale-redis-1 redis-cli HGETALL analytics:revenueMinorByCurrency
```

See [docs/analytics.md](docs/analytics.md) for why revenue is rolled up
on `order.paid` specifically (not `order.created`), the outbox payload
change this required, and how four pre-existing `order.paid` events from
earlier phases' testing were handled by design when this brand-new
consumer group replayed the stream from the beginning.

### Trying the integration tests

```bash
pnpm test:integration        # up (--wait) -> prisma migrate deploy -> vitest run
pnpm test:integration:down   # tear the disposable stack back down (-v)
```

The flagship test fires 10 truly concurrent `POST /api/v1/reservations`
requests for the SAME seat through a real `buildApp()` against a real
Postgres/Redis pair and asserts exactly one `201` and nine `409
SEAT_NOT_AVAILABLE` -- something `reservation.service.test.ts`'s mocked
Prisma structurally cannot prove. See [docs/testing.md](docs/testing.md)
for the unit-vs-integration split, why this uses its own disposable
`docker-compose.test.yml` rather than the dev stack, and two real bugs
this phase found by literally running the new test twice (a host port
collision with an unrelated local service, and an idempotency-key reuse
bug in the test's own isolation).

### Trying the load test

```bash
docker compose up -d --build
pnpm --filter @flashsale/load-tests run provision
MSYS_NO_PATHCONV=1 docker run --rm --network flashsale_flashsale-net \
  -v "$(pwd)/tests/load:/scripts" grafana/k6 run /scripts/seat-reservation.js
pnpm --filter @flashsale/load-tests run cleanup
```

Two scenarios run back to back: `hot_seat_contention` (many VUs fighting
over 3 seats, proving rejections stay cheap once it's empty) and
`general_throughput` (a realistic depletion curve across 300 seats). See
[docs/load-testing.md](docs/load-testing.md) for why sessions are
provisioned out of band (the login route's own rate limit), and three
real bugs this phase found live — including the exact connection-pool
bottleneck [docs/database.md](docs/database.md) predicted since Phase 3.

### Trying failure testing

```bash
# Redis outage: session lookups and seat locks now fail within ~2s
# (SERVICE_UNAVAILABLE), not hang indefinitely -- see docs/failure-testing.md
docker stop flashsale-redis-1
curl -i -b fan.txt http://localhost:4000/api/v1/me   # 503 in ~2s
docker start flashsale-redis-1

# Postgres outage: a clean 500 within a few seconds, /ready reports it,
# api and worker both auto-recover with no restart needed
docker stop flashsale-postgres-1
curl http://localhost:4000/ready                      # {"status":"degraded",...}
docker start flashsale-postgres-1

# Worker crash: kill it mid-job (not a graceful `docker stop`) and watch
# the outbox row/BullMQ job survive in Postgres/Redis, then get
# processed on restart with nothing lost
docker kill -s SIGKILL flashsale-worker-1
docker start flashsale-worker-1
```

See [docs/failure-testing.md](docs/failure-testing.md) for all three
experiments in full, including the real indefinite-hang bug this phase
found and fixed.

### Trying CSRF protection

```bash
# Login now sets TWO cookies -- capture both:
curl -k -c fan.txt -X POST https://localhost:8443/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"fan@flashsale.dev","password":"Password123!"}'
CSRF_TOKEN=$(grep flashsale_csrf fan.txt | awk '{print $7}')

# A mutating request with NO X-CSRF-Token header -- 403, not the seat logic:
curl -k -b fan.txt -X POST https://localhost:8443/api/v1/reservations \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: csrf-demo-1' \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}"
# {"success":false,"error":{"code":"CSRF_VALIDATION_FAILED",...}}

# The same request WITH the correct token -- succeeds normally:
curl -k -b fan.txt -X POST https://localhost:8443/api/v1/reservations \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: csrf-demo-2' \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}"

# GET routes need no token at all:
curl -k -b fan.txt https://localhost:8443/api/v1/me
```

See [docs/production-hardening.md](docs/production-hardening.md) for how
the signed double-submit cookie works, why it lives inside `requireAuth`
rather than a per-route preHandler, and a real bug this phase's own live
testing found (Secure cookies silently dropped without TLS, fixed by
adding it).

### Full containerized stack

To run every service in Docker (proves the production Dockerfiles,
inter-service networking, and graceful shutdown under real container
signal delivery — see [docs/deployment.md](docs/deployment.md)):

```bash
docker compose up -d --build
curl http://localhost:8080/health          # through Nginx -- no TLS needed for this one
curl -k https://localhost:8443/            # everything else redirects here (Phase 20, self-signed cert)
open https://localhost:8443                # the web app, through Nginx+TLS (your browser will warn -- self-signed)
```

### Trying the AWS deployment config (validate only, no real AWS account needed)

```bash
cd infra/terraform
docker run --rm -v "$(pwd):/workspace" -w /workspace hashicorp/terraform init
docker run --rm -v "$(pwd):/workspace" -w /workspace hashicorp/terraform validate
docker run --rm -v "$(pwd):/workspace" -w /workspace hashicorp/terraform fmt -check
```

This is as far as this project takes it — real HCL/schema validation
against the AWS provider, no real account or credentials needed, same
"official Docker image, nothing to install" pattern Phase 18 used for
k6. Actually running `terraform plan`/`apply` needs real AWS credentials
and will provision (and bill for) real resources — see
[docs/aws-deployment.md](docs/aws-deployment.md) for the full
architecture, why that step was deliberately left undone, and how to run
it yourself if you choose to.

## Verifying the skeleton

```bash
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

```bash
pnpm test        # apps/api health-route tests via Fastify .inject()
pnpm typecheck    # strict TypeScript across every package
pnpm lint         # ESLint flat config, shared across the monorepo
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — system architecture, ER model, all 21 phases
- [docs/deployment.md](docs/deployment.md) — Docker setup, port remapping, gotchas hit in Phase 2
- [docs/database.md](docs/database.md) — schema, indexes, the partial-unique-index seat-locking invariant, ID strategy trade-offs
- [docs/auth-flow.md](docs/auth-flow.md) — registration, OTP, sessions, why Redis/BullMQ arrived early
- [docs/admin-flow.md](docs/admin-flow.md) — venues/events/seats, RBAC, sync-vs-background seat generation, a real Fastify hook bug found and fixed
- [docs/event-browsing.md](docs/event-browsing.md) — cache-aside + stampede protection, search/filter/pagination, why the list route isn't cached
- [docs/redis.md](docs/redis.md) — Redis key strategy (Phase 7+)
- [docs/rate-limiting.md](docs/rate-limiting.md) — atomic fixed-window limits, fail-open design, per-endpoint budgets (Phase 8)
- [docs/reservation-flow.md](docs/reservation-flow.md) — seat locking + correctness, required Idempotency-Key, expiry sweeper, a live Fastify onSend bug (Phase 9)
- [docs/outbox.md](docs/outbox.md) — the dual-write problem, atomic outbox writes, why a Stream not Pub/Sub, at-least-once delivery (Phase 10)
- [docs/streams.md](docs/streams.md) — consumer groups, idempotent dedup on outboxId, XAUTOCLAIM crash recovery, blocking reads vs polling (Phase 11)
- [docs/queues.md](docs/queues.md) — real retry/backoff (a gap since Phase 4), the failed-job set as this project's DLQ, the reservation-expiry delayed-job race (Phase 12)
- [docs/payment-flow.md](docs/payment-flow.md) — order creation, mock provider + real async webhook, idempotent dedup, retry-after-failure (Phase 13)
- [docs/tickets.md](docs/tickets.md) — atomic issuance in the payment-success transaction, the ticket number format, a real Ticket.seatId relation bug found live (Phase 14)
- [docs/pubsub.md](docs/pubsub.md) — Redis Pub/Sub fan-out, one shared subscriber connection per process, live viewer presence, deferred live seat-map broadcasting (Phase 15)
- [docs/analytics.md](docs/analytics.md) — a second independent consumer group, the shared stream-consumer-loop extraction, event counters + revenue rollup, a real pre-existing-payload gap handled by design (Phase 16)
- [docs/testing.md](docs/testing.md) — unit vs. integration test split, the disposable docker-compose.test.yml stack, the automated seat-concurrency proof, two real bugs found by running it twice (Phase 17)
- [docs/load-testing.md](docs/load-testing.md) — k6 hot-seat + general-throughput scenarios, out-of-band session provisioning, three real bugs found live including the connection-pool bottleneck docs/database.md predicted (Phase 18)
- [docs/failure-testing.md](docs/failure-testing.md) — Redis/Postgres outages and an ungraceful worker SIGKILL against the live stack, the real indefinite-hang bug this found and fixed, and two confirmed-correct resilience claims (Phase 19)
- [docs/production-hardening.md](docs/production-hardening.md) — signed double-submit CSRF, secrets management, a worker health endpoint, the Phase 18 connection-pool fix re-measured, and Nginx TLS added after live testing found a real Secure-cookie bug (Phase 20)
- [docs/checkout-lifecycle.md](docs/checkout-lifecycle.md) — checkout timeout, cancellation, automatic refunds, paid-booking cancellation, live seat maps, idempotency-key cleanup, the public list cache
- [docs/azure-deployment.md](docs/azure-deployment.md) — Azure Container Apps + Postgres Flexible Server + Azure Managed Redis + ACS Email, Terraform, GitHub Actions CI/CD, bootstrap and operations
- [docs/aws-deployment.md](docs/aws-deployment.md) — the full ECS Fargate/RDS/ElastiCache/ALB Terraform architecture, why it replaces Nginx with the ALB, every deliberate cost/scope tradeoff, and why this phase was validated but never applied against a real AWS account (Phase 21, final)

(Populated incrementally as each phase lands.)
