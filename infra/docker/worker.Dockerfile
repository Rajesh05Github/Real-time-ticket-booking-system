# syntax=docker/dockerfile:1
# See api.Dockerfile for the full explanation of the prune/install/build/run
# staging pattern -- identical here, targeting @flashsale/worker instead.

FROM node:22-alpine AS base
# See api.Dockerfile: openssl is required for Prisma's query engine on
# Alpine/musl, needed as of Phase 4 (@flashsale/database is now a real
# dependency here too, for updating Notification rows from the email
# worker).
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx --yes turbo@2.10.12 prune @flashsale/worker --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm turbo run build --filter=@flashsale/worker...

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 flashsale && \
    adduser --system --uid 1001 worker --ingroup flashsale
USER worker

COPY --from=builder --chown=worker:flashsale /app .

ENV NODE_ENV=production

# Phase 20: the tiny liveness-only health port (health-server.ts) --
# previously this file had no EXPOSE at all since the worker had no HTTP
# surface whatsoever. The actual HEALTHCHECK lives in docker-compose.yml,
# same split as api.Dockerfile/docker-compose.yml's `api` service (this
# file declares the port exists; Compose decides how to poll it).
EXPOSE 4100

CMD ["node", "apps/worker/dist/index.js"]
