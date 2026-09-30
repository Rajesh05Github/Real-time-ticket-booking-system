# Deployment (Phase 2: Docker)

This covers what Phase 2 actually built: containerizing every service and
proving it works end-to-end. Full AWS deployment prep is Phase 21 — this
document will grow into that, not be replaced by it.

## Two ways to run this project locally

They serve different purposes; don't conflate them.

### 1. Host-run dev (day-to-day coding)

```bash
docker compose up -d postgres redis
pnpm dev
```

`api`/`worker`/`web` run directly on the host via `tsx watch` / `next dev`,
giving fast hot-reload. Only the two stateful dependencies are
containerized. This is what you use while actively writing code.

### 2. Full containerized stack (proving the real thing works)

```bash
docker compose up -d --build
```

Every service — `postgres`, `redis`, `api`, `worker`, `web`, `nginx` — runs
as its own container on one Docker network, `nginx` fronting `api`/`web`.
This is the closest local approximation to the eventual AWS shape (section
60), and the only way to actually verify:

- The production Dockerfiles build correctly (turbo-pruned multi-stage).
- Inter-service networking works via container DNS (`postgres`, `redis`,
  `api`, `web` resolve as hostnames, not `localhost`).
- Docker healthchecks correctly reflect real service state.
- **Graceful shutdown under real SIGTERM delivery.** This is the one thing
  Phase 1 could not verify: Windows does not deliver true POSIX signals to
  arbitrary processes, so `kill -TERM` / `Stop-Process` on a host-run
  Node process there hard-kills it regardless of the signal handler code.
  Docker Desktop's Linux VM does deliver real SIGTERM on `docker compose
  stop`, which is how this was actually confirmed working end-to-end:
  ```
  {"signal":"SIGTERM","msg":"received shutdown signal, draining connections"}
  {"msg":"shutdown complete"}
  ```
  for both `api` and `worker`, container exiting cleanly without ever
  hitting the force-kill timeout.

## Why `DATABASE_URL`/`REDIS_URL` differ between `.env` and `docker-compose.yml`

`.env` is read by host-run processes (`pnpm dev`), so it points at
`localhost:<mapped-port>`. `docker-compose.yml` sets its own values for
the containerized `api`/`worker`, pointing at the container-network
service names (`postgres:5432`, `redis:6379`) — `localhost` inside a
container refers to that container itself, not to a sibling container.
Reusing one `.env` for both would silently break whichever mode wasn't
being actively tested.

## Non-standard host ports

This machine already runs other projects' Postgres/Redis/web servers on
the conventional ports, and Windows separately reserves port 80 at the OS
level (HTTP.sys-backed system services hold it even with nothing
user-visible running there). Rather than fight either of those, FLASHSALE
rebinds its **host-side** ports only — every container-internal port is
still the standard one:

| Service  | Standard port | This project's host port |
|----------|---------------|---------------------------|
| Postgres | 5432          | 5450                      |
| Redis    | 6379          | 6381                      |
| Nginx    | 80            | 8080                      |
| API      | 4000          | 4000 (unaffected)         |
| Web      | 3000          | 3000 (unaffected)         |

On a real deployment target (a dedicated EC2 instance, Phase 21) these
collisions won't exist and Nginx would bind `80:80` normally — the remap
here is a **LOCAL DEVELOPMENT SIMPLIFICATION** specific to this machine,
not a permanent architectural choice. If you deploy this stack on a clean
host, revert `nginx`'s port mapping to `'80:80'` in `docker-compose.yml`.

## A real gotcha this stack hit on first boot: `localhost` vs `127.0.0.1` in healthchecks

The API's Docker healthcheck originally used `wget --spider
http://localhost:4000/health` and failed every single time with
"connection refused" — even though the server logs clearly showed it
listening and answering requests. Cause: Alpine's `wget` resolves
`localhost` to `::1` (IPv6) first, but Fastify's `HOST=0.0.0.0` binds
IPv4 only. The healthcheck was contacting a port nothing was listening on
in the *address family* it tried first. Fixed by using `127.0.0.1`
explicitly in the healthcheck command. This is exactly the kind of
container networking subtlety worth having hit for real once.

## Dockerfile pattern: turbo prune multi-stage builds

Each of `infra/docker/{api,worker,web}.Dockerfile` follows the same four
stages:

1. **pruner** — `turbo prune <app> --docker` computes exactly which
   workspace packages this app's dependency graph actually needs, and
   writes a trimmed copy of the monorepo to `/app/out`. Without this,
   every image would contain all 7 workspace packages' source and
   devDependencies regardless of whether the app imports them.
2. **installer** — `pnpm install --frozen-lockfile` against only the
   pruned `package.json` files.
3. **builder** — copies in the pruned full source, runs `turbo run build
   --filter=<app>...`.
4. **runner** — copies only compiled output (+ production
   `node_modules` for api/worker, or Next's traced `.next/standalone` for
   web) into a minimal final layer, running as a non-root user.

`tsconfig.base.json` is copied explicitly into the builder stage as a
belt-and-braces measure: every package's `tsconfig.json` extends it via a
relative path, but it isn't part of any `package.json` dependency graph,
so it's easy for a purely dependency-graph-based prune to miss even
though `turbo.json`'s `globalDependencies` already lists it.

## Next.js standalone output in a monorepo

`apps/web/next.config.ts` sets `output: 'standalone'` (so the production
image ships only the modules the app actually imports, not the full
`node_modules` tree) and pins `outputFileTracingRoot` to the monorepo
root. Without the latter, Next's file tracer can auto-detect the wrong
workspace root in a monorepo and silently omit a workspace package
(`@flashsale/shared`) from the traced output — a failure that would only
surface as a runtime `Cannot find module` error in the container, not at
build time.

`NEXT_PUBLIC_API_URL` is passed as a Docker build **arg**, not a runtime
environment variable — Next.js inlines `NEXT_PUBLIC_*` values into the
client JS bundle at build time. Changing it requires rebuilding the image,
not just restarting the container. It's also set to the address the
**browser** can reach (`http://localhost:8080/api`, through Nginx), not
the container-network `api` hostname, which only resolves for other
containers.

## Redis persistence: `--appendonly yes --maxmemory-policy noeviction`

- **AOF (`appendonly yes`)**: without it, `docker compose restart redis`
  (or a host reboot) silently discards every session, lock, counter, and
  — critically once Phase 11 lands — every Redis Stream entry. That
  directly contradicts the "Streams are durable" story this project
  teaches. RDB snapshots alone aren't sufficient, since a snapshot only
  captures state as of its last save point.
- **`noeviction`** (Redis's default, stated explicitly rather than left
  implicit): Redis must never silently evict a key to free memory. An
  evicted lock or session would violate the correctness assumptions
  sections 5 and 21 depend on. Under real memory pressure this makes
  Redis start *rejecting writes* instead of corrupting state — loud and
  visible, the correct failure mode, not silent and wrong.

## What Phase 2 deliberately does NOT do yet

- `/ready` still reports `not_configured` for both Postgres and Redis —
  wiring up real connectivity checks requires the database client
  (Phase 3) and Redis client (Phase 7), which don't exist yet.
- No database migrations run against the Postgres container — it's an
  empty database until Phase 3's Prisma schema lands.
- No Nginx TLS/HTTPS termination — that's part of the Phase 20 production
  hardening pass, alongside real secrets management (see the
  `POSTGRES_PASSWORD`/`COOKIE_SECRET` LOCAL DEVELOPMENT SIMPLIFICATION
  notes in `docker-compose.yml`).
