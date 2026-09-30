# syntax=docker/dockerfile:1
#
# Multi-stage build for @flashsale/api, following the standard
# Turborepo + pnpm "prune" pattern for monorepos:
#   pruner    - ask turbo which files THIS app's dependency subgraph
#               actually needs, discarding the rest of the monorepo.
#   installer - install deps for exactly that pruned subgraph.
#   builder   - copy in full pruned source, compile.
#   runner    - copy only compiled output + production node_modules.
#
# Why prune instead of `COPY . .` + `pnpm install`: without it, every
# app image would contain devDependencies and source for all 7
# workspace packages (web, worker, every package/*), even though the
# API never imports most of them. That bloats the image and widens
# the attack surface for no benefit.
#
# Build context is the REPO ROOT (see docker-compose.yml `context: .`),
# not this directory -- turbo prune needs to see the whole workspace.

FROM node:22-alpine AS base
# openssl, added in Phase 4: Prisma's query engine binary (needed once
# @flashsale/database is a real dependency, as of this phase) links
# against OpenSSL at runtime -- without it present on Alpine/musl, the
# engine fails to load with an opaque "libssl.so.3: cannot open shared
# object file" error at container start, not at build time. See
# docs/database.md's binaryTargets note (Phase 3) for the matching
# `linux-musl-openssl-3.0.x` generator config in schema.prisma.
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx --yes turbo@2.10.12 prune @flashsale/api --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
# Belt-and-braces: tsconfig.base.json is a root file every package's
# tsconfig `extends`, but it isn't part of any package.json dependency
# graph, so it's easy for a pruning tool to miss it even though
# turbo.json's globalDependencies already lists it. Copying it
# explicitly means a build break here is impossible regardless of
# turbo's internal prune behavior.
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm turbo run build --filter=@flashsale/api...

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 flashsale && \
    adduser --system --uid 1001 fastify --ingroup flashsale
USER fastify

COPY --from=builder --chown=fastify:flashsale /app .

EXPOSE 4000
ENV NODE_ENV=production

# Section 37: SIGTERM handling lives in apps/api/src/shutdown.ts. Plain
# `node`, not an init wrapper like tini, because Fastify's own close()
# sequence IS the graceful-shutdown logic -- an init system would only
# be needed if we were forwarding signals to a CHILD process, which we
# aren't.
CMD ["node", "apps/api/dist/server.js"]
