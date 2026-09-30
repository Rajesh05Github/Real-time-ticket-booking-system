import cookie from '@fastify/cookie';
import { SESSION_COOKIE_NAME } from '@flashsale/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Same seam as rbac.test.ts: mocking getSession lets this test drive the
// REAL requireAuth/requireRole preHandlers without touching real Redis
// for the session lookup itself.
vi.mock('../auth/session.js', () => ({
  getSession: vi.fn(),
  touchSessionIfStale: vi.fn().mockResolvedValue(undefined),
}));

const { getSession } = await import('../auth/session.js');
const { registerErrorHandler } = await import('../../plugins/error-handler.js');
const { analyticsRoutes } = await import('./analytics.routes.js');

const TEST_COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters-long';

describe('GET /summary', () => {
  let app: FastifyInstance;
  let hgetall: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = Fastify();
    registerErrorHandler(app);
    await app.register(cookie, { secret: TEST_COOKIE_SECRET, hook: 'onRequest' });

    hgetall = vi
      .fn()
      .mockResolvedValueOnce({ 'order.paid': '3', 'order.created': '5' })
      .mockResolvedValueOnce({ INR: '450000' });
    app.decorate('redis', { hgetall } as never);

    app.get('/sign-cookie/:sessionId', (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, { signed: true, path: '/' }).send({ ok: true });
    });

    await app.register(analyticsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signedCookieFor(sessionId: string): Promise<string> {
    const response = await app.inject({ method: 'GET', url: `/sign-cookie/${sessionId}` });
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error('test setup failed: no Set-Cookie header returned');
    const nameValue = raw.split(';')[0];
    if (!nameValue) throw new Error('test setup failed: malformed Set-Cookie header');
    return nameValue;
  }

  it('rejects an unauthenticated request with 401', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const response = await app.inject({ method: 'GET', url: '/summary' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a non-ADMIN session with 403', async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: 'user-1',
      role: 'USER',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const sessionCookie = await signedCookieFor('user-session');
    const response = await app.inject({ method: 'GET', url: '/summary', headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(403);
  });

  it('returns both Redis hashes verbatim (revenue as strings, not numbers) for an ADMIN session', async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: 'admin-1',
      role: 'ADMIN',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const sessionCookie = await signedCookieFor('admin-session');
    const response = await app.inject({ method: 'GET', url: '/summary', headers: { cookie: sessionCookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        eventCounts: { 'order.paid': '3', 'order.created': '5' },
        revenueMinorByCurrency: { INR: '450000' },
      },
    });
    expect(hgetall).toHaveBeenCalledWith('analytics:eventCounts');
    expect(hgetall).toHaveBeenCalledWith('analytics:revenueMinorByCurrency');
  });
});
