# Phase 21 — AWS Deployment Prep

## Scope, decided explicitly, not by default

Every prior phase in this project followed the same discipline: build it,
then prove it works against the real, running thing (a real Docker
container, real Postgres, real Redis, a real k6 run, a real killed
process). That discipline cannot extend to this phase in the same way --
"does this Terraform config correctly provision a working AWS
deployment" can only be answered by actually applying it against a real
AWS account, which costs real money and requires real credentials this
project doesn't have standing permission to use.

Asked directly, the answer chosen for this phase was: **infrastructure-
as-code and documentation only, never applied against a real AWS
account.** `infra/terraform/` is validated the way `docs/load-testing.md`'s
k6 script and `docs/testing.md`'s integration-test stack were validated
in their own phases -- via the official Docker image, so nothing extra
needs installing locally -- but `terraform validate` only proves the HCL
is syntactically correct and internally consistent against the AWS
provider's real resource schemas. It does NOT prove an actual `apply`
would succeed (IAM permission edge cases, account-level service quotas,
and region-specific availability are all things only a real `apply`
against a real account can surface). That gap is inherent to this scope
choice, not an oversight.

## Architecture

```
Internet
   |
   v
Application Load Balancer (public subnets, 2 AZs)
   |  TLS termination here (ACM cert, if a domain was supplied)
   |  path-based routing: /api/* -> api target group
   |                       everything else -> web target group
   |
   +--> ECS Fargate: api tasks   (private subnets) --+
   +--> ECS Fargate: web tasks   (private subnets)   |
                                                       |
        ECS Fargate: worker tasks (private subnets) --+--> RDS Postgres (private, single-AZ)
        (no ALB -- not public-facing, same as         +--> ElastiCache Redis (private, single node)
         docker-compose.yml's worker service today)
```

This is a direct AWS-native translation of `docker-compose.yml`'s own
topology, with ONE structural change: **there is no Nginx ECS service.**
Phase 20's Nginx container did two jobs -- TLS termination and path-based
routing. The ALB is AWS's managed, highly-available primitive for
EXACTLY those two jobs; running an Nginx container behind (or instead of)
it would be duplicating what the ALB already does, not adding anything.
`docs/production-hardening.md` flagged this exact possibility when Phase
20 built the self-signed-cert Nginx setup: "a real deployment terminating
TLS with an ACM-issued certificate would most plausibly do so at an
Application Load Balancer, not Nginx." This is that prediction, followed
through.

## Why ECS Fargate, not EKS or plain EC2

- **Not EKS**: this project has no Kubernetes anywhere in its stack, and
  introducing one exclusively for the AWS deployment phase would teach
  Kubernetes concepts orthogonal to everything the previous 20 phases
  actually built (Redis Streams, BullMQ, the outbox pattern, connection
  pooling -- all Kubernetes-agnostic). ECS is the AWS-native equivalent
  that doesn't require learning a second orchestration system's mental
  model on top of everything else.
- **Not plain EC2**: this project already fully commits to Docker
  (`docker-compose.yml`, three purpose-built Dockerfiles since Phase 2).
  Fargate runs those exact same images with no EC2 instances to patch,
  size, or manage -- the natural next step from "docker compose up" on
  one machine, not a step backward to managing servers by hand.

## What Phase 20's work carries over directly

- **`connection_limit=20`/`=10`** (api/worker `DATABASE_URL`, Phase 20's
  fix for Phase 18's own finding) -- baked into the Secrets Manager
  `database_url`/`database_url_worker` secrets exactly as-is. The problem
  those numbers solved (Postgres connection contention under load) exists
  identically on RDS.
- **The worker health endpoint** (`health-server.ts`) -- becomes the ECS
  task definition's `healthCheck` block for the worker (which has no ALB
  target group to report health through any other way), and the SAME
  `/health` path the ALB's api target group polls.
- **CSRF's `COOKIE_SECRET`** -- one Secrets Manager secret, referenced by
  the api task definition exactly the way `apps/api/src/plugins/csrf.ts`'s
  own comment explains it: one secret serving two purposes (session
  signing AND deriving the CSRF token) rather than introducing a second.
- **No committed secrets** (Phase 20's `docker-compose.yml` hardening) --
  the same principle one level up: every secret here is
  `random_password`-generated at `apply` time and referenced by ARN in
  task definitions, never written to a `.tfvars` file or Terraform state
  in a way meant to be checked in.

## What's genuinely new in this phase

- **Multiple replicas, for real, for the first time.** `api_desired_count`
  and `worker_desired_count` both default to 2. Every one of this
  project's consumer/worker abstractions was already DESIGNED for this
  (Phase 11's `docs/streams.md` explicitly noted the per-process
  `${hostname()}:${process.pid}` consumer name "is already unique per
  process, so running two worker replicas would correctly split the
  stream between them with no code change" -- Phase 21 is the first time
  that claim is even structurally possible to exercise, though still not
  exercised for real without a real `apply`).
- **A managed database and cache** instead of containers holding their
  own state on a Docker volume -- RDS handles Postgres's own durability
  concerns (backups, patching) that `docker-compose.yml`'s `postgres_data`
  volume left entirely to the operator.
- **IAM**, least-privilege by construction: the ECS execution role can
  read exactly the 5 secrets these task definitions reference (no
  `secretsmanager:*`), and the task role is deliberately EMPTY -- nothing
  in this codebase's application code calls another AWS API directly yet.

## Deliberate cost/availability tradeoffs (stated, not hidden)

- **One NAT gateway, not one per AZ.** A single point of failure for
  private-subnet egress; the HA alternative costs roughly 2-3x for a
  teaching project whose point is the application layer, not maximizing
  infrastructure availability.
- **`db_multi_az = false`, single ElastiCache node.** Mirrors
  `docker-compose.yml`'s own single-instance Postgres/Redis exactly --
  Phase 19's failure testing already proved this codebase's OWN behavior
  under a dependency outage is correct (fails fast, recovers cleanly);
  this phase doesn't need to ALSO prove AWS's HA primitives work to
  validate that, and skipping them keeps this a realistic "smallest
  correct deployment," not a maximally-available one.
- **No CloudFront, no WAF.** The ALB serves both `web` and `api/*`
  directly. A CDN in front of `web`'s static assets and a WAF in front of
  the whole thing are both real, valid production hardening -- genuinely
  out of scope for a prep phase that was never going to be applied
  against real traffic.

## Running this for real (if you choose to)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in your own values
docker run --rm -it -v "$(pwd):/workspace" -w /workspace \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  hashicorp/terraform init
docker run --rm -it -v "$(pwd):/workspace" -w /workspace \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  hashicorp/terraform plan
```

Before `apply` would actually produce a running app, the three ECR repos
`terraform apply` creates need real images pushed to them (build each
`infra/docker/*.Dockerfile`, tag with whatever `*_image_tag` you set in
`terraform.tfvars`, `docker push`) -- provisioning infrastructure and
publishing application images are different concerns with different
lifecycles, deliberately not one script.

## What Phase 21 deliberately does not include

- **A CI/CD pipeline.** Building images, pushing to ECR, and updating ECS
  services on every merge is real, valuable follow-on work (GitHub
  Actions / CodePipeline) -- genuinely a different concern (continuous
  delivery) from provisioning the infrastructure those deploys land on.
- **Actually running `terraform apply`.** Decided explicitly, not
  defaulted into -- see "Scope" above.
- **Blue/green or canary deployments.** ECS supports both natively (via
  CodeDeploy); this config uses ECS's default rolling update instead,
  the simplest correct option for a first deployment.
- **Multi-region / disaster recovery.** One region, one AZ pair. A real
  DR strategy is its own substantial topic, not a checkbox to add here.
