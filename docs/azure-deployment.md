# Azure deployment

FLASHSALE runs on Azure as Container Apps, backed by Postgres Flexible
Server, Azure Managed Redis and Azure Communication Services Email. All of
it is defined in `infra/azure/terraform/`. The GitHub Actions workflow in
`.github/workflows/azure-deploy.yml` tests, builds, migrates and rolls out
every push to `main`.

This guide covers the architecture, the one-time bootstrap, day-2
operations, and what this setup deliberately leaves out.

## Architecture

```
                 Internet
                    │ HTTPS (Container Apps managed certificate)
                    ▼
        ┌───────────────────────┐   Container Apps environment (VNet-injected)
        │ gateway  (nginx)      │   the ONLY public app
        │  /api/*  ─────────────┼──► api     (internal ingress, 1..N replicas, WebSockets)
        │  /*      ─────────────┼──► web     (internal ingress, Next.js SSR)
        └───────────────────────┘    worker  (no ingress: BullMQ, outbox, stream consumers,
                                              expiry sweeper, refund processor, key cleanup)
                                     migrate (manual job: prisma migrate deploy)
                    │ private network only
        ┌───────────┴─────────────┬──────────────────────────┐
        ▼                         ▼                          ▼
 Postgres Flexible Server   Azure Managed Redis         Key Vault (secrets)
 (VNet-integrated,          (private endpoint,          ACR (images)
  no public endpoint)        NoCluster, AOF, TLS)       ACS Email (OTP delivery)
```

| Local (`docker-compose.yml`) | Azure | Why |
|---|---|---|
| nginx container (TLS + path routing) | `gateway` container app (nginx) behind Container Apps' managed-TLS ingress | Container Apps routes by host name, not path. One origin for web and api keeps cookies first-party and the WebSocket free of CORS. |
| `api`, `worker`, `web` containers | Container apps built from the same Dockerfiles | Same images, no Azure-specific code paths. |
| `postgres:17` | Postgres Flexible Server 16, private | Managed backups and point-in-time restore, no public endpoint. |
| `redis:7 --appendonly yes --maxmemory-policy noeviction` | Azure Managed Redis: `NoCluster`, `NoEviction`, AOF every 1s | See [Redis choice](#why-azure-managed-redis). |
| `.env` secrets | Key Vault, referenced by the apps through a managed identity | No secret values live in app definitions. |
| Console email provider | ACS Email (`EMAIL_PROVIDER=acs`) | Real OTP delivery. |

### Why Azure Managed Redis

Azure Cache for Redis (Basic, Standard and Premium) is being retired.
New cache creation has been blocked for new customers since
2026-04-01, and for existing customers from 2026-10-01. That rules it
out for a new deployment, so this config uses its successor,
[Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/architecture).

Four settings matter for this codebase:

- **`clustering_policy = "NoCluster"`**: BullMQ's Lua scripts and the
  rate limiter touch several keys at once. The OSS and Enterprise cluster
  policies reject cross-slot multi-key commands. This needs azurerm
  ≥ 4.50, which the provider pin (`~> 4.60`) guarantees.
- **`eviction_policy = "NoEviction"`**: an evicted session, lock or
  queue job would be silent corruption. Rejecting writes is the loud,
  correct failure mode, same as the local stack.
- **AOF persistence (1s)**: the domain-event stream and BullMQ queues
  must survive a node restart.
- **TLS on port 10000**: `REDIS_URL` is `rediss://…`. `packages/config`
  accepts that scheme and ioredis handles it natively.

### Real client IPs behind the gateway

Per-IP rate limits (login/register/OTP) need the *real* client address.
Container Apps' edge proxy appends it to `X-Forwarded-For`. The gateway
trusts only private and CGNAT source ranges and walks the header from the
right (`real_ip_recursive`), so a client-supplied fake `X-Forwarded-For`
is ignored. The gateway then **overwrites** the header before proxying to
the api.

This was checked against the real gateway image during development: a
spoofed `X-Forwarded-For: 1.1.1.1, 9.9.9.9` produced a rate-limit key for
`9.9.9.9`, never `1.1.1.1`.

## Cost (rough, pay-as-you-go, small defaults)

Estimates only. Check the Azure pricing calculator for your region.

| Resource | Default | ≈ / month |
|---|---|---|
| Container Apps (5 apps, 0.25–0.5 vCPU, min 1 replica each) | Consumption | $60–120 |
| Postgres Flexible Server | `B_Standard_B2s`, 32 GB | $30–60 |
| Azure Managed Redis | `Balanced_B0`, HA | $50–110 |
| ACR Standard, Key Vault, Log Analytics, ACS Email | | $25–50 |

For real production load, raise `postgres_sku` to a `GP_` SKU and set
`postgres_zone_redundant_ha = true`. Raise the replica counts too.

## One-time bootstrap

Prerequisites:

- Azure CLI (`az login`), Terraform ≥ 1.7
- **Owner** (or Contributor + User Access Administrator) on the target
  subscription, because the config creates role assignments.
- The resource providers `Microsoft.App`, `Microsoft.DBforPostgreSQL`,
  `Microsoft.Cache`, `Microsoft.Communication`,
  `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`,
  `Microsoft.OperationalInsights` and `Microsoft.Network` registered
  (`az provider register -n <name>`).

### 1. Remote state (recommended)

Terraform state holds every generated secret (DB password, Redis key), so
it belongs in a locked-down storage account, not on a laptop:

```bash
az group create -n rg-flashsale-tfstate -l centralindia
az storage account create -n <globally-unique-name> -g rg-flashsale-tfstate --sku Standard_LRS --allow-blob-public-access false --min-tls-version TLS1_2
az storage container create -n tfstate --account-name <that-name> --auth-mode login
```

Then uncomment the `backend "azurerm"` block in `versions.tf` and fill in
the names. You need the *Storage Blob Data Contributor* role on that
account.

### 2. Configure

```bash
cd infra/azure/terraform
cp terraform.tfvars.example terraform.tfvars   # set subscription_id, location, ...
terraform init
```

### 3. Create the registry, then push images

The container apps can't be created until their images exist, so create
the registry (and everything it depends on) first:

```bash
terraform apply -target=azurerm_container_registry.main
../scripts/build-and-push.sh "$(terraform output -raw acr_name)"   # builds in Azure via az acr build; prints the tag
```

### 4. Apply everything

Set `image_tag` in `terraform.tfvars` to the tag the script printed, then:

```bash
terraform apply
```

This creates the network, Postgres, Redis, Key Vault (with secrets), ACS
Email, the environment, the four apps and the migrate job.

### 5. Run the first migration

```bash
RG=$(terraform output -raw resource_group)
JOB=$(terraform output -raw migrate_job_name)
az containerapp job start -g "$RG" -n "$JOB"
az containerapp job execution list -g "$RG" -n "$JOB" -o table   # wait for Succeeded
```

The api stays not-ready (`/ready` fails) until its tables exist. This is
expected on a brand-new database.

### 6. Create the first admin

Never run `seed.ts` in production: it creates accounts with a published
password. Instead:

1. Open `terraform output -raw public_url`, register an account and verify
   its email. The OTP arrives through ACS.
2. Promote it by running the migrate job with a command override:

```bash
az containerapp job start -g "$RG" -n "$JOB" \
  --container-name migrate \
  --command "packages/database/node_modules/.bin/tsx" \
  --args "packages/database/prisma/promote-admin.ts" "you@example.com"
az containerapp job execution list -g "$RG" -n "$JOB" -o table   # Succeeded = promoted; logs show why otherwise
```

The override applies to that one execution only; the job's normal
command stays `prisma migrate deploy`.

Log in again afterwards; the role is read at login.

## CI/CD

`.github/workflows/azure-deploy.yml` runs these jobs:

- **Every PR and push**: build, lint, typecheck, unit tests, and
  integration tests against Postgres/Redis service containers.
- **Push to `main`**:
  1. Build four images in parallel and push them to ACR tagged with the
     commit SHA.
  2. Point the migrate job at the new api image, run it, and wait for it.
  3. Roll out worker, api, web and gateway.
  4. Smoke-test `/health` and `/api/v1/events` on the public URL.

It logs in with GitHub OIDC, so no Azure password is stored anywhere.

1. Create an Entra app registration (or user-assigned identity). Add a
   federated credential for `repo:<owner>/<repo>:environment:production`.
2. Set `ci_principal_object_id` in `terraform.tfvars` to its **object id**
   and re-apply. That grants exactly *AcrPush* on the registry and
   *Contributor* on the resource group.
3. Create a GitHub environment named `production`. Add required reviewers
   if you want a manual approval gate before each deploy.
4. Add these repository **variables**:

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | the app registration's client id |
| `AZURE_TENANT_ID` | your tenant id |
| `AZURE_SUBSCRIPTION_ID` | the subscription |
| `AZURE_RESOURCE_GROUP` | `terraform output -raw resource_group` |
| `ACR_NAME` | `terraform output -raw acr_name` |
| `MIGRATE_JOB` | `terraform output -raw migrate_job_name` |
| `CA_API` / `CA_WORKER` / `CA_WEB` / `CA_GATEWAY` | from `terraform output container_app_names` |
| `PUBLIC_URL` | `terraform output -raw public_url` |

After bootstrap, **CI owns image versions**. Terraform ignores image drift
(`lifecycle.ignore_changes`) so a later `terraform apply` never rolls an
app back to the bootstrap tag. Terraform still owns everything else:
env vars, scaling, secrets and networking.

Migrations run *before* the rollout, while the previous revision is still
serving. That is safe only for backward-compatible (additive) migrations,
which every migration in this repo is. A destructive change (dropping or
renaming a column still in use) needs the usual two-deploy
expand/contract sequence.

## Custom domain

1. Set `custom_domain = "tickets.example.com"` and apply. This adds it to
   the api's CORS origins.
2. At your DNS provider:
   - `CNAME tickets.example.com → <terraform output -raw gateway_default_hostname>`
   - `TXT asuid.tickets.example.com → <terraform output -raw gateway_custom_domain_verification_id>`
3. Bind it with a free managed certificate:

```bash
az containerapp hostname add  -g "$RG" -n <gateway app> --hostname tickets.example.com
az containerapp hostname bind -g "$RG" -n <gateway app> --hostname tickets.example.com \
  --environment <env name> --validation-method CNAME
```

For real email volume, also add the domain to ACS Email as a custom
sending domain (SPF/DKIM records) and request a quota increase. The
Azure-managed `*.azurecomm.net` sender has a deliberately low quota.

## Operations

| Task | How |
|---|---|
| Logs | Log Analytics → `ContainerAppConsoleLogs_CL` (JSON lines from pino; filter on `service`, `requestId`) |
| Rotate `COOKIE_SECRET` / webhook secret | New Key Vault secret version, then `az containerapp revision restart` (sessions and CSRF tokens signed with the old cookie secret stop working) |
| Scale | `api_max_replicas` / `worker_replicas` etc. in `terraform.tfvars`. Keep `api_max_replicas × 10 + worker_replicas × 10` well under the Postgres SKU's `max_connections`. |
| Point-in-time restore | Postgres Flexible Server → Restore (up to `postgres_backup_retention_days`) |
| Stuck refunds | `SELECT id, order_id FROM payments WHERE status = 'REFUND_PENDING'`. The worker logs every failed attempt and retries each tick. |

## What this deliberately does not include

- **A real payment gateway (by decision).** The deployment deliberately
  runs with the dummy provider (`provider = 'mock'`): every charge
  auto-confirms after ~3s and refunds are simulated, and the checkout and
  order pages tell users that no real money is involved. A real integration means one
  `PaymentProvider` (apps/api), one `RefundProvider` registered in
  `apps/worker/src/index.ts`, and a webhook signature check. The refund
  pipeline around it is already real.
- **WAF / Front Door.** Put Azure Front Door (with WAF) in front of the
  gateway if you need edge caching or bot protection.
- **Multi-region.** One region, zone-redundant only where you opt in.
- **Private container registry / Key Vault endpoints.** Both use RBAC
  over their public endpoints. Add private endpoints and firewall rules if
  your policy requires network isolation there too.

## Verification status

- `terraform validate` and `terraform fmt` pass against azurerm 4.81.
- The gateway image was built and run locally. It rendered its template,
  proxied REST and WebSocket traffic to a real api, and carried a live
  seat update end to end. Client-IP spoofing was rejected.
- `terraform plan`/`apply` were **not** run against a real subscription as
  part of this change. The first real apply is the step still to be
  verified.
