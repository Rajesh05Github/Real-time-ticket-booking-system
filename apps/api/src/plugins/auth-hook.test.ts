import cookie from '@fastify/cookie';
import { SESSION_COOKIE_NAME } from '@flashsale/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Same seam as rbac.test.ts: mocking getSession lets this test drive the
// REAL requireAuth/resolveSession logic without touching real Redis.
vi.mock('../modules/auth/session.js', () => ({
  getSession: vi.fn(),
  touchSessionIfStale: vi.fn().mockResolvedValue(undefined),
}));

const { getSession } = await import('../modules/auth/session.js');
const { registerErrorHandler } = await import('./error-handler.js');
const { requireAuth } = await import('./auth-hook.js');

const TEST_COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters-long';

/**
 * Regression test for a real bug found live by Phase 19's failure
 * testing: with Redis genuinely unreachable, `getSession` throwing (now
 * bounded by packages/redis's `commandTimeout` instead of hanging
 * indefinitely) previously fell through error-handler.ts's generic
 * catch-all as a misleading `500 INTERNAL_SERVER_ERROR` -- indistinguishable
 * from an actual application bug. `resolveSession` now catches that
 * specific failure and throws `ServiceUnavailableError` (503) instead.
 */
describe('requireAuth when the session store is unreachable', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerErrorHandler(app);
    await app.register(cookie, { secret: TEST_COOKIE_SECRET, hook: 'onRequest' });
    app.decorate('redis', {} as never);

    app.get('/sign-cookie/:sessionId', (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, { signed: true, path: '/' }).send({ ok: true });
    });

    app.get('/protected', { preHandler: requireAuth }, async () => ({ ok: true }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a thrown Redis error to 503 SERVICE_UNAVAILABLE, not a generic 500', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('Command timed out'));

    const signed = await app.inject({ method: 'GET', url: '/sign-cookie/some-session-id' });
    const setCookie = signed.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionCookie = (raw as string).split(';')[0] as string;

    const response = await app.inject({ method: 'GET', url: '/protected', headers: { cookie: sessionCookie } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('still returns a plain 401 (not 503) when there is simply no session, unaffected by the new branch', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: '/protected' });

    expect(response.statusCode).toBe(401);
  });
});
