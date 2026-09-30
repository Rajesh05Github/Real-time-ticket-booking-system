import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    // *.integration.test.ts files (Phase 17, vitest.integration.config.ts)
    // need a REAL Postgres/Redis and are excluded here on purpose: this
    // config's whole point is to fail fast against the unreachable
    // placeholder port below, so the fast/always-safe `pnpm test` suite
    // must never silently try to run one of those against it.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    // Env validation (src/env.ts) runs at import time and fails fast on
    // missing vars -- these are syntactically-valid dummy values that
    // satisfy the Zod schema for tests that don't need real connectivity
    // (e.g. the 404-envelope test). Port 59999 is deliberately an
    // essentially-guaranteed-unused port, NOT 5432/6379 -- this machine
    // runs other local projects' real Postgres/Redis containers on the
    // standard ports, and pointing "should be unreachable" test config at
    // a standard port risks nondeterministically succeeding against
    // someone else's database. The /ready test relies on this actually
    // failing fast and consistently. Real integration tests against a
    // live Postgres/Redis get their own docker-compose test services
    // (Phase 17 -- vitest.integration.config.ts, docker-compose.test.yml,
    // docs/testing.md), not these placeholders.
    env: {
      DATABASE_URL: 'postgresql://test:test@localhost:59999/flashsale_test',
      REDIS_URL: 'redis://localhost:59999',
      COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters-long',
      PAYMENT_WEBHOOK_SECRET: 'test-payment-webhook-secret-value',
      LOG_LEVEL: 'error',
    },
  },
});
