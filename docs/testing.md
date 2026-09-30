# Phase 17 — Real Integration Tests Against a Live Postgres/Redis

## Why a second test config, not just more unit tests

Every test in this codebase before Phase 17 mocked Prisma and/or Redis
entirely (`vi.mock('@flashsale/database', ...)`, `fakeRedis()` helpers
throughout `apps/api`/`apps/worker`). That's the right default -- fast,
deterministic, no external state -- but it structurally CANNOT prove the
one claim repeated across every reservation-flow doc since Phase 9: *"ten
truly concurrent requests for the same seat produce exactly one 201 and
nine 409s, enforced by the Postgres partial unique index."* A mocked
Prisma client has no transaction, no unique index, and no way to lose a
real race. Until this phase, that claim had only ever been checked by
hand -- curl loops against a live Docker stack, the result read off the
terminal and never re-run automatically again.

Phase 17 adds a SECOND, deliberately separate test surface for exactly
this class of claim: `apps/api/src/**/*.integration.test.ts`, run via
`vitest.integration.config.ts` against a real, disposable Postgres/Redis
pair, never against the mocked unit suite's placeholder config.

## Two test configs, two databases, on purpose

| | `vitest.config.ts` | `vitest.integration.config.ts` |
|---|---|---|
| Matches | `*.test.ts` | `*.integration.test.ts` |
| DATABASE_URL/REDIS_URL | `localhost:59999` -- deliberately unreachable | `docker-compose.test.yml`'s real containers |
| What it proves | application logic, given a Prisma/Redis call behaves a certain way | that the REAL call behaves that way, including real concurrency |
| Run via | `pnpm test` (turbo, every phase's default) | `pnpm test:integration` (root) -- explicit, not part of `pnpm test` |

The exclusion is mutual and explicit, not just "different include globs
that happen not to overlap": `vitest.config.ts`'s `include` (`*.test.ts`)
would ALSO match an `*.integration.test.ts` file, so it carries an
explicit `exclude` for that pattern too -- without it, `pnpm test` (the
fast, always-safe-to-run suite every phase's CI-equivalent depends on)
would silently try to run a real-Postgres test against the unreachable
placeholder port and fail confusingly.

`docker-compose.test.yml` is a SEPARATE compose file from
`docker-compose.yml`, not an extra service inside it, and deliberately has
no named volumes -- `pnpm test:integration:down` (`docker compose -f
docker-compose.test.yml down -v`) always returns to a byte-for-byte clean
slate. Reusing the dev stack's own Postgres/Redis would mean an
integration test run could corrupt whatever you're currently looking at
in `psql`/`redis-cli` while developing, or a test that crashes mid-run
could poison the next dev session with leftover rows.

## Running it

```bash
pnpm test:integration        # up (--wait) -> migrate deploy -> vitest run
pnpm test:integration:down   # tear the disposable stack back down (-v)
```

`pnpm test:integration` is three steps chained (`test:integration:up`,
`@flashsale/database`'s `migrate:deploy:test`, `@flashsale/api`'s
`test:integration`) rather than one script, mirroring how
`docker-compose.yml`'s full stack is brought up manually rather than
auto-torn-down -- an integration test run failing partway through is
something you want to INSPECT (`docker exec ... psql`), not have silently
cleaned up out from under you.

## Two real bugs, found live, by running this exact test twice

**1. A port collision, not a Postgres or Prisma bug.** The first attempt
picked host port 5436 for `postgres-test` (one past the dev stack's
5435) and Prisma's `migrate deploy` failed with a generic `P1000
Authentication failed`, even though the exact same password worked via
`docker exec ... psql` and a `docker run --network host` psql client.
`netstat -ano` on the host showed the real cause: two OTHER, unrelated
local processes were already `LISTENING` on `0.0.0.0:5436` -- Prisma's
Windows-native connection through the Docker-forwarded port was reaching
one of those, not the test Postgres container, while the `docker exec`/
`--network host` checks happened to route through Docker's internal
network and never touched the contended host port at all. Moved to 5440
(confirmed free via the same `netstat` check) and it worked immediately.
The lesson generalizes past this one number: a "wrong password" error
from a tool that never touches your actual password is a signal to check
what's *listening on that port*, not to re-check credentials.

**2. Idempotency-Key reuse across test runs.** The first successful run
used fixed literal keys (`phase17-concurrency-0` .. `-9`). Running the
SAME test a second time against the SAME (not yet torn down) database
failed: `succeeded` came back empty. `idempotency_keys` has a real
`@@unique([route, key])` constraint (docs/reservation-flow.md) that a
mocked unit test never exercises across two separate runs the way a
persistent real database does -- the second run's 10 requests all hit
their OWN key's row already `COMPLETED` from run one, with a DIFFERENT
request body (a fresh seat is created per run), so every one of them hit
the `IDEMPOTENCY_KEY_REUSED` branch instead of racing a real seat. Fixed
by generating a `randomUUID()`-scoped key prefix per test process, plus
an explicit `idempotencyKey.deleteMany` in `afterAll` for hygiene between
runs that don't `down -v` in between. This is a bug in the TEST's
isolation, not the application -- the idempotency guard did exactly what
Phase 9 designed it to do, given a genuinely reused key -- but it's
exactly the kind of bug that only a real, persistent database (not a
fresh mock per test file) can produce, which is itself a small
demonstration of why this test surface exists.

## What Phase 17 deliberately does not include

- **A k6/load-testing suite.** `README.md`'s `tests/` directory
  description ("k6 load tests, concurrency tests") describes where that
  work will live once it exists -- concurrency CORRECTNESS (this phase's
  flagship test) and load/throughput testing are different questions,
  and conflating them into one phase would blur what each test is
  actually proving. Load testing is a later, separate phase.
- **Integration coverage for every route.** One flagship test
  (reservation concurrency) was chosen because it's the one claim a
  mocked unit test structurally cannot prove. Not every route needs a
  real-database counterpart -- most of this codebase's correctness
  properties (validation, RBAC, response shapes) are fully provable
  against mocks, and duplicating that coverage against a slower, stateful
  database would add runtime cost without adding confidence.
- **CI wiring.** This phase adds the local developer-facing commands
  (`pnpm test:integration[:up|:down]`); wiring a CI pipeline to run them
  automatically (bring up docker-compose.test.yml as a CI service, run
  migrations, run the suite, tear down) is a natural next step but out of
  scope for a project without a CI pipeline defined yet.
