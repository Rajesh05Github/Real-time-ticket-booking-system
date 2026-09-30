import cookie from '@fastify/cookie';
import { SESSION_COOKIE_NAME } from '@flashsale/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mocking the session module (not `../../modules/auth/session.js`'s
// consumers) means this test never touches real Redis -- `getSession` is
// the ONLY seam auth-hook.ts uses to reach Redis, so replacing it lets
// the test drive `requireAuth`/`requireRole` with a fully-controlled fake
// session while exercising their REAL preHandler logic and REAL
// interaction with Fastify's hook runner (the thing that actually hung).
vi.mock('../modules/auth/session.js', () => ({
  getSession: vi.fn(),
  touchSessionIfStale: vi.fn().mockResolvedValue(undefined),
}));

const { getSession } = await import('../modules/auth/session.js');
const { registerErrorHandler } = await import('./error-handler.js');
const { requireAuth, optionalAuth } = await import('./auth-hook.js');
const { requireRole } = await import('./rbac.js');

const TEST_COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters-long';

/**
 * Regression test for the Phase 5 bug: a synchronous preHandler
 * (`roleGuard`, before it was fixed to be `async`) positioned AFTER an
 * async one (`requireAuth`) in a preHandler ARRAY hung every request
 * indefinitely on the SUCCESS path only -- confirmed live against a
 * running Docker container by bisection (see docs/admin-flow.md).
 * Rejection paths (401/403, where the hook throws) worked fine even with
 * the bug present, which is exactly why per-test timeouts below matter:
 * a regression here wouldn't fail with an assertion error, it would hang
 * until the timeout fires.
 */
describe('requireAuth + requireRole composed in a preHandler array', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    // Without this, thrown AppErrors (UnauthorizedError, ForbiddenError)
    // fall through to Fastify's DEFAULT error handler, which has no idea
    // these map to 401/403 -- every one of them would surface as a
    // generic 500, masking the actual rejection-path status codes this
    // suite verifies.
    registerErrorHandler(app);
    await app.register(cookie, { secret: TEST_COOKIE_SECRET, hook: 'onRequest' });
    // Not a real Redis client -- getSession is mocked above, so
    // touchSessionIfStale (also mocked) is the only thing that ever
    // reads this decoration, and it ignores its arguments.
    app.decorate('redis', {} as never);

    // Test-only helper: produces a validly-signed session cookie the
    // same way apps/api/src/modules/auth/auth.routes.ts's real login
    // route does, without duplicating @fastify/cookie's signing
    // internals in this test file.
    app.get('/sign-cookie/:sessionId', (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      reply
        .setCookie(SESSION_COOKIE_NAME, sessionId, { signed: true, path: '/' })
        .send({ ok: true });
    });

    app.get(
      '/admin-only',
      { preHandler: [requireAuth, requireRole('ADMIN')] },
      async () => ({ ok: true }),
    );

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
    // Extract just "name=value" from the full Set-Cookie header (which
    // also carries Path=, HttpOnly, etc.) -- exactly what a browser would
    // send back on the next request.
    const nameValue = raw.split(';')[0];
    if (!nameValue) throw new Error('test setup failed: malformed Set-Cookie header');
    return nameValue;
  }

  it(
    'lets an ADMIN session through without hanging',
    async () => {
      vi.mocked(getSession).mockResolvedValue({
        userId: 'admin-user-id',
        role: 'ADMIN',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      const sessionCookie = await signedCookieFor('admin-session');
      const response = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    },
    // Short, explicit timeout: if this regresses, the failure mode is a
    // HANG, not a thrown error -- the default test timeout would still
    // catch it, but a tight one here makes the intent ("this must
    // resolve fast, not eventually") explicit and fails CI quickly.
    2000,
  );

  it(
    'rejects a non-ADMIN session with 403 (and does not hang either)',
    async () => {
      vi.mocked(getSession).mockResolvedValue({
        userId: 'regular-user-id',
        role: 'USER',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      const sessionCookie = await signedCookieFor('user-session');
      const response = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(403);
    },
    2000,
  );

  it(
    'rejects a missing session with 401',
    async () => {
      vi.mocked(getSession).mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: '/admin-only' });

      expect(response.statusCode).toBe(401);
    },
    2000,
  );
});

describe('every exported preHandler is an async function', () => {
  // Direct guard against reintroducing the root cause: a sync function
  // (no `async` keyword, no returned Promise) composed into a
  // preHandler array is what caused the hang in the first place.
  // Fastify's hook runner behaves correctly when every hook in an array
  // is consistently async -- this asserts that invariant holds for every
  // preHandler this codebase exports, not just the one that broke.
  it('requireAuth is async', () => {
    expect(requireAuth.constructor.name).toBe('AsyncFunction');
  });

  it('optionalAuth is async', () => {
    expect(optionalAuth.constructor.name).toBe('AsyncFunction');
  });

  it("requireRole(...)'s returned guard is async", () => {
    expect(requireRole('ADMIN').constructor.name).toBe('AsyncFunction');
  });
});
