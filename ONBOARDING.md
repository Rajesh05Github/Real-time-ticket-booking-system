# Onboarding: FLASHSALE

Welcome. This doc gets you from a fresh clone to a running stack, orients
you in the codebase, and points you at the deeper docs for whichever part
you're about to touch. Read top to bottom your first day; after that,
it's a reference.

## What this project is

FLASHSALE is a distributed, production-shaped event ticket booking
platform, built deliberately as a **teaching vehicle** for distributed
systems concepts: concurrency correctness, idempotency, the transactional
outbox pattern, Redis in most of its data structures (cache, locks, rate
limiting, Pub/Sub, Streams), BullMQ job queues, graceful shutdown,
observability, load/failure testing, and AWS deployment prep.

It shipped across **21 phases**, each one following the same discipline:
build the feature, verify it against the real running stack (not just
unit tests), write up what was learned (including real bugs found live),
then move on. `docs/` is the accumulated record of that — treat it as the
primary reference, not this file. Nearly every non-obvious design
decision in the codebase has a paragraph in one of those files explaining
*why*, often citing a bug that was found and fixed live.

## Prerequisites

- Node.js >= 22, pnpm >= 10 (`packageManager` pins the exact pnpm version
  in `package.json`)
- Docker + Docker Compose
- A `.env` file at the repo root — copy `.env.example` and fill in real
  values for `COOKIE_SECRET`, `PAYMENT_WEBHOOK_SECRET`, and
  `POSTGRES_PASSWORD` (Phase 20 hardening removed all committed
  fallback defaults — `docker compose up` fails loudly without these,
  on purpose; see `docs/production-hardening.md`)

## Getting running

Two ways to run this locally, pick based on what you're doing:

**Fast inner loop** (editing code, want hot reload):
```bash
docker compose up -d postgres redis   # just the two stateful dependencies
pnpm install
pnpm --filter @flashsale/database run migrate:deploy
pnpm dev                              # tsx watch on api/worker, next dev on web
```

**Full stack** (verifying Dockerfiles, Nginx/TLS, graceful shutdown, or
just want the whole thing running):
```bash
docker compose up -d --build
curl http://localhost:8080/health          # through Nginx, no TLS needed
curl -k https://localhost:8443/            # everything else redirects here (self-signed cert)
```

See `docs/deployment.md` for exactly what each container does and every
port-remapping gotcha (several standard ports are remapped to avoid
colliding with other local services — this is Windows/shared-machine
specific, not universal).

## Repo layout

```
apps/
  api/      Fastify HTTP API -- the source of truth for business logic
  worker/   BullMQ workers, outbox publisher, Redis Streams consumers
  web/      Next.js app (still a skeleton -- no real UI has been built
            against this API yet; every "Trying X" example in README.md
            uses curl for exactly this reason)
packages/
  database/       Prisma schema, migrations, seed data
  redis/          Redis client, key builder (packages/redis/src/keys.ts is
                   the single source of truth for every Redis key this
                   project uses -- read it before adding a new one)
  shared/         Cross-cutting types, error classes, constants
  config/         Zod-validated environment loading
  logger/         Structured JSON logging (Pino)
  eslint-config/  Shared lint rules
tests/load/       k6 load-test scripts + session-provisioning scripts
                  (its own workspace package, deliberately outside the
                  normal build/lint/typecheck pipeline -- k6 scripts run
                  in k6's own JS runtime, not Node)
infra/
  docker/         The three production Dockerfiles (api/worker/web)
  nginx/          Nginx config + self-signed dev cert generation
  terraform/      AWS deployment IaC (validated, never applied -- see below)
docs/             Per-topic deep dives -- see the index below
docker-compose.yml        Full local stack (Nginx + api + worker + web + postgres + redis)
docker-compose.test.yml   Disposable Postgres/Redis for integration tests
```

## The docs index (read the ones relevant to what you're touching)

| Doc | What it covers |
|---|---|
| `docs/database.md` | Schema, indexes, the partial-unique-index seat-locking invariant, ID strategy tradeoffs |
| `docs/deployment.md` | Docker setup, port remapping, container gotchas |
| `docs/auth-flow.md` | Registration, OTP, sessions, why Redis/BullMQ arrived early |
| `docs/admin-flow.md` | Venues/events/seats, RBAC, sync-vs-background seat generation |
| `docs/event-browsing.md` | Cache-aside + stampede protection |
| `docs/redis.md` | The full Redis key registry, data-structure choices |
| `docs/rate-limiting.md` | Atomic fixed-window limits, fail-open design |
| `docs/reservation-flow.md` | Seat locking + correctness — **read this before touching reservations** |
| `docs/outbox.md` | The dual-write problem, transactional outbox, at-least-once delivery |
| `docs/streams.md` | Consumer groups, idempotent dedup, XAUTOCLAIM crash recovery |
| `docs/queues.md` | BullMQ retry/backoff policy, the failed-job set as this project's DLQ |
| `docs/payment-flow.md` | Order creation, mock provider, async webhook, idempotent dedup |
| `docs/tickets.md` | Atomic issuance, ticket number format |
| `docs/pubsub.md` | Redis Pub/Sub fan-out, live viewer presence |
| `docs/analytics.md` | A second independent consumer group, event counters + revenue |
| `docs/testing.md` | Unit vs. integration test split, the disposable Postgres/Redis stack |
| `docs/load-testing.md` | k6 scenarios, why sessions are provisioned out of band |
| `docs/failure-testing.md` | Real Redis/Postgres outages and a worker SIGKILL against the live stack |
| `docs/production-hardening.md` | CSRF, secrets management, worker health, connection pooling, TLS |
| `docs/aws-deployment.md` | The Terraform architecture, every deliberate scope/cost tradeoff |

**Known gap:** several docs (including this file) reference
`docs/architecture.md#phases` for the full phase list — that file was
never actually written. If you need the phase-by-phase history, the
`docs/*.md` files above are the closest thing, each one Phase-numbered.

## Core patterns you'll run into constantly

- **Idempotency-Key required on mutating requests** — `POST /reservations`
  and a few other routes reject requests with no `Idempotency-Key`
  header. See `apps/api/src/plugins/idempotency.ts` and
  `docs/reservation-flow.md`.
- **CSRF double-submit cookie** — every `requireAuth`-protected mutating
  request needs a matching `X-CSRF-Token` header (set from the
  `flashsale_csrf` cookie login returns). See
  `apps/api/src/plugins/csrf.ts` and `docs/production-hardening.md`.
- **Redis locks are admission control, not correctness** — real
  correctness (e.g. "only one person can claim a seat") is always
  enforced by a Postgres constraint (partial unique index, `@@unique`,
  etc.), never by a Redis lock alone. Redis just reduces wasted Postgres
  transactions under contention. `docs/reservation-flow.md` explains this
  in depth, and `docs/failure-testing.md` proves it holds even when Redis
  is completely down.
- **The transactional outbox** — any write that needs to reliably notify
  something else (a Stream consumer, eventually a webhook) writes an
  `OutboxEvent` row in the SAME transaction as the business write, then a
  separate publisher ships it. Never write directly to a Stream/queue
  inside a request handler. `docs/outbox.md`.
- **`redisKeys` is the only place Redis key strings get built** —
  `packages/redis/src/keys.ts`. Every entry documents type, purpose, TTL,
  owner, and cleanup. Don't hand-write a Redis key string anywhere else.
- **Every `AppError` subclass maps to one HTTP status + one machine
  code** — see `packages/shared/src/errors/app-error.ts`. Fastify's OWN
  built-in errors (malformed body, etc.) are also mapped to their real
  status by `error-handler.ts`, not swallowed into a generic 500 — this
  was a real bug found in Phase 18.

## Running the different test surfaces

```bash
pnpm test                    # fast unit suite, fully mocked, no external state
pnpm test:integration        # real Postgres/Redis via docker-compose.test.yml
pnpm test:integration:down   # tear that disposable stack back down

# Load testing (needs the full stack up first: docker compose up -d --build)
pnpm --filter @flashsale/load-tests run provision
docker run --rm --network flashsale_flashsale-net \
  -v "$(pwd)/tests/load:/scripts" grafana/k6 run /scripts/seat-reservation.js
pnpm --filter @flashsale/load-tests run cleanup
```

`pnpm test` must stay fast and dependency-free — if you're tempted to hit
a real Postgres/Redis from a `*.test.ts` file, it belongs in a
`*.integration.test.ts` file instead (excluded from `pnpm test`, picked
up by `pnpm test:integration`). See `docs/testing.md`.

## Before you open a PR

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

All four must pass clean — this is the same bar every phase of this
project held itself to. If you touched anything Docker-related (an env
var, a Dockerfile, docker-compose.yml), also rebuild and smoke-test the
container: `docker compose up -d --build <service>` and hit its
health/ready endpoint before considering the change done.

## A note on the AWS deployment config

`infra/terraform/` is real, validated Infrastructure-as-Code (ECS
Fargate, RDS, ElastiCache, an ALB replacing Nginx's TLS/routing job) —
but it has **never been applied against a real AWS account**. That was a
deliberate scope decision, not laziness: applying it costs real money and
needs real credentials this project doesn't have standing access to.
`terraform validate` (via the official Docker image, no local install
needed) proves the HCL is schema-correct; it does not prove a real
`apply` would succeed end to end. If you're the one who eventually runs
this for real, read `docs/aws-deployment.md` first — it documents every
cost/availability tradeoff explicitly (single NAT gateway, no Multi-AZ,
no CloudFront/WAF) so you're not surprised by what it deliberately
doesn't do.
