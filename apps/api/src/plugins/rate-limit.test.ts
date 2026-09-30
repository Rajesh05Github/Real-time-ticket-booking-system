import { consumeRateLimit } from '@flashsale/redis';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerErrorHandler } from './error-handler.js';
import { rateLimit } from './rate-limit.js';

import type { Redis } from '@flashsale/redis';

function fakeRedis(eval_: ReturnType<typeof vi.fn>): Redis {
  return { eval: eval_ } as unknown as Redis;
}

describe('consumeRateLimit (fixed-window Lua script)', () => {
  it('invokes eval with numkeys=1, the key, and windowSeconds as ARGV[1]', async () => {
    const evalFn = vi.fn().mockResolvedValue([1, 60]);
    const redis = fakeRedis(evalFn);

    await consumeRateLimit(redis, 'ratelimit:login:1.2.3.4', 10, 60);

    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, 'ratelimit:login:1.2.3.4', 60);
  });

  it('allows the request while the count is at or under the limit', async () => {
    const redis = fakeRedis(vi.fn().mockResolvedValue([10, 60]));
    const result = await consumeRateLimit(redis, 'k', 10, 60);
    expect(result).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60 });
  });

  it('blocks once the count exceeds the limit, reporting the real TTL as retryAfterSeconds', async () => {
    const redis = fakeRedis(vi.fn().mockResolvedValue([11, 37]));
    const result = await consumeRateLimit(redis, 'k', 10, 60);
    expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 37 });
  });

  it('fails open (allowed: true) when Redis is unreachable', async () => {
    const redis = fakeRedis(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await consumeRateLimit(redis, 'k', 10, 60);
    expect(result.allowed).toBe(true);
  });
});

describe('rateLimit preHandler', () => {
  let app: FastifyInstance;
  let evalFn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = Fastify();
    registerErrorHandler(app);
    evalFn = vi.fn();
    app.decorate('redis', fakeRedis(evalFn));

    app.get(
      '/limited',
      { preHandler: rateLimit({ bucket: 'test', limit: 2, windowSeconds: 60 }) },
      async () => ({ ok: true }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets requests through under the limit', async () => {
    evalFn.mockResolvedValueOnce([1, 60]);
    const response = await app.inject({ method: 'GET', url: '/limited' });
    expect(response.statusCode).toBe(200);
  });

  it('returns 429 with a Retry-After header and the RATE_LIMIT_EXCEEDED code once the bucket is exhausted', async () => {
    evalFn.mockResolvedValueOnce([3, 42]);
    const response = await app.inject({ method: 'GET', url: '/limited' });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    expect(response.json()).toMatchObject({
      error: { code: 'RATE_LIMIT_EXCEEDED' },
    });
  });

  it('fails open: a Redis error never blocks the request', async () => {
    evalFn.mockRejectedValueOnce(new Error('down'));
    const response = await app.inject({ method: 'GET', url: '/limited' });
    expect(response.statusCode).toBe(200);
  });
});

describe('rateLimit(...)', () => {
  it('returns an async function, consistent with every other preHandler in this codebase', () => {
    expect(rateLimit({ bucket: 'x', limit: 1, windowSeconds: 1 }).constructor.name).toBe(
      'AsyncFunction',
    );
  });
});
