import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The Node.js API is the source of truth for business logic; the web app
  // only reads NEXT_PUBLIC_API_URL (set per-environment) and never embeds
  // secrets client-side. See docs/architecture.md for the request path:
  // browser -> Next.js (Server Component fetch, or client fetch to
  // route handlers only where genuinely needed) -> Node.js API.

  // 'standalone' traces only the modules apps/web actually imports into
  // .next/standalone, instead of shipping the full node_modules tree in
  // the production Docker image (infra/docker/web.Dockerfile).
  output: 'standalone',

  // Monorepo gotcha: Next's file tracer auto-detects the workspace root by
  // walking up for a lockfile, which usually works -- but pinning it
  // explicitly avoids a real failure mode where the trace misses a
  // workspace package (@flashsale/shared) because it resolved the wrong
  // root, producing a container that builds fine but throws "Cannot find
  // module '@flashsale/shared'" at runtime. Pointing this at the repo root
  // makes the trace deterministic regardless of where `next build` runs
  // from inside the multi-stage Docker build.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
};

export default nextConfig;
