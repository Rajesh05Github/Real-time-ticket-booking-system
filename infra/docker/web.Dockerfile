# syntax=docker/dockerfile:1
# See api.Dockerfile for the prune/install/build/run explanation. The web
# app's runner stage is different from api/worker's: Next.js `output:
# 'standalone'` (apps/web/next.config.ts) produces its OWN minimal
# node_modules subset under .next/standalone, so the runner copies that
# instead of reinstalling production dependencies itself.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx --yes turbo@2.10.12 prune @flashsale/web --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
COPY tsconfig.base.json ./tsconfig.base.json

# NEXT_PUBLIC_* vars are inlined into the client JS bundle AT BUILD TIME,
# not read at container start -- unlike every other env var in this
# project. That means changing NEXT_PUBLIC_API_URL requires rebuilding
# this image, not just restarting the container. This is a genuine Next.js
# constraint, not a shortcut: there is no way to make a browser-side
# constant reactive to a runtime env var without a client-side fetch to
# discover it.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm turbo run build --filter=@flashsale/web...

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 flashsale && \
    adduser --system --uid 1001 nextjs --ingroup flashsale
USER nextjs

# Standalone output nests under apps/web/ because outputFileTracingRoot
# (next.config.ts) is pinned to the monorepo root -- these three copies
# are the entire standalone runtime: server.js + traced node_modules,
# static assets, and public files, in that order.
COPY --from=builder --chown=nextjs:flashsale /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:flashsale /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:flashsale /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
