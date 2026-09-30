import { defineConfig } from 'vitest/config';

/**
 * Phase 17's OTHER test config, deliberately separate from
 * vitest.config.ts: that file's DATABASE_URL/REDIS_URL are placeholders
 * pointed at an intentionally-unreachable port (59999) so purely mocked
 * unit tests fail fast and consistently if one accidentally tries to hit
 * a real connection. This config is the opposite -- every value here
 * points at a REAL, running Postgres/Redis pair (docker-compose.test.yml),
 * because integration tests exist specifically to exercise real
 * connections, real transactions, and real concurrency that mocking
 * Prisma/ioredis cannot -- see docs/testing.md.
 *
 * Not merged into vitest.config.ts's `include` because these tests
 * require `docker compose -f docker-compose.test.yml up` to be running
 * first; `pnpm test` (the fast, always-safe-to-run unit suite) must never
 * silently depend on that.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.integration.test.ts'],
    // Real Postgres/Redis round-trips plus N concurrent HTTP requests
    // through a real Fastify app take meaningfully longer than a mocked
    // unit test -- vitest's 5s default has already been observed to be
    // too tight for the concurrency test below under a cold connection
    // pool.
    testTimeout: 20_000,
    env: {
      DATABASE_URL: 'postgresql://flashsale:flashsale@localhost:5440/flashsale_test',
      REDIS_URL: 'redis://localhost:6381',
      COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters-long',
      PAYMENT_WEBHOOK_SECRET: 'test-payment-webhook-secret-value',
      LOG_LEVEL: 'error',
    },
  },
});
