import { prisma } from '@flashsale/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../app.js';

import type { FastifyInstance } from 'fastify';

/**
 * Uses Fastify's `.inject()` -- an in-process request, no real socket bound.
 * This is the pattern all API tests (section 45) will follow: fast,
 * no port conflicts, no network flakiness.
 *
 * The degraded-/ready test mocks `prisma.$queryRaw`/`app.redis.ping`
 * rather than pointing DATABASE_URL/REDIS_URL at a genuinely unreachable
 * host. That was tried first and doesn't work reliably: Prisma's engine
 * bootstraps a connection lazily on first query, and its internal
 * connection-failure promise is a DIFFERENT object from the one
 * `$queryRaw()` returns -- attaching a rejection handler to our own
 * promise doesn't reach it, so Node still flags it as an unhandled
 * rejection and crashes the test process. Mocking the dependency calls
 * directly avoids ever triggering that real connection attempt, which is
 * also just a better unit test: it's deterministic and fast instead of
 * depending on OS-level TCP connection-refused timing.
 */

interface HealthBody {
  status: string;
  uptimeSeconds: number;
}

interface ReadyBody {
  status: string;
  checks: Record<string, string>;
}

interface ErrorEnvelopeBody {
  success: false;
  error: { code: string; message: string };
}

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 and does not touch downstream dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthBody>();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('GET /ready reports 503 and per-dependency errors when Postgres/Redis are unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('simulated Postgres outage'));
    vi.spyOn(app.redis, 'ping').mockRejectedValue(new Error('simulated Redis outage'));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    const body = response.json<ReadyBody>();
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('error');
    expect(body.checks.redis).toBe('error');
  });

  it('GET /ready reports 200 when Postgres/Redis both respond', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ '?column?': 1 }]);
    vi.spyOn(app.redis, 'ping').mockResolvedValue('PONG');

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    const body = response.json<ReadyBody>();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.redis).toBe('ok');
  });

  it('unknown route returns the standard error envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorEnvelopeBody>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
