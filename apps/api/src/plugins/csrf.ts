import { createHmac, timingSafeEqual } from 'node:crypto';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CsrfError } from '@flashsale/shared';

import { env } from '../env.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Signed double-submit cookie (Phase 20, docs/security-hardening.md):
 * `csrfTokenFor(sessionId)` is deterministic, so no server-side storage
 * is needed at all -- this server can always recompute what a given
 * session's token SHOULD be and compare, rather than looking one up.
 * Keyed on COOKIE_SECRET (the same secret that signs the session cookie
 * itself), not a separate secret -- this token is meaningless without
 * already knowing which session it's for, so reusing that secret adds no
 * real cross-purpose risk and avoids introducing a second one to manage.
 */
function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', env.COOKIE_SECRET).update(sessionId).digest('hex');
}

/**
 * Sets the CSRF cookie alongside the session cookie -- called from
 * auth.routes.ts's `/login` (the ONLY place a session cookie is newly
 * issued). Deliberately NOT `httpOnly`: the frontend's own JS has to read
 * this value to echo it back in `CSRF_HEADER_NAME`; `httpOnly` would make
 * that impossible and defeat the entire mechanism.
 */
export function setCsrfCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(CSRF_COOKIE_NAME, csrfTokenFor(sessionId), {
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

export function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
}

/**
 * Called from auth-hook.ts's `requireAuth`, AFTER the session itself is
 * already resolved and trusted -- this only verifies that THIS specific
 * request also proves it can read that session's cookies, which a
 * cross-site attacker's page cannot do (same-origin policy blocks
 * reading `document.cookie` for another origin, and SameSite=Lax already
 * blocks the cookie from being SENT on a cross-site non-GET request in
 * the first place -- this is deliberate defense IN DEPTH on top of that,
 * not the only line of defense; see docs/security-hardening.md for why
 * both layers are kept).
 *
 * Skipped entirely for safe methods (GET/HEAD/OPTIONS): those don't
 * mutate state, so there's nothing for CSRF to protect here, and
 * requiring the header on every read would force every authenticated GET
 * in this codebase (GET /me, GET /reservations, ...) to also carry it
 * for no security benefit.
 */
export function verifyCsrf(request: FastifyRequest, sessionId: string): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }

  const headerValue = request.headers[CSRF_HEADER_NAME];
  const cookieValue = request.cookies[CSRF_COOKIE_NAME];

  if (typeof headerValue !== 'string' || typeof cookieValue !== 'string') {
    throw new CsrfError('Missing CSRF token.');
  }

  const expected = csrfTokenFor(sessionId);

  // timingSafeEqual requires equal-length buffers -- comparing lengths
  // first (not itself a useful side channel: token length is fixed and
  // public) avoids it throwing on a mismatched length instead of
  // returning false.
  const headerBuffer = Buffer.from(headerValue);
  const cookieBuffer = Buffer.from(cookieValue);
  const expectedBuffer = Buffer.from(expected);

  const headerMatches =
    headerBuffer.length === expectedBuffer.length && timingSafeEqual(headerBuffer, expectedBuffer);
  const cookieMatches =
    cookieBuffer.length === expectedBuffer.length && timingSafeEqual(cookieBuffer, expectedBuffer);

  if (!headerMatches || !cookieMatches) {
    throw new CsrfError('Invalid or stale CSRF token.');
  }
}
