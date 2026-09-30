import { ServiceUnavailableError, SESSION_COOKIE_NAME, UnauthorizedError } from '@flashsale/shared';

import { getSession, touchSessionIfStale, type SessionData } from '../modules/auth/session.js';

import { verifyCsrf } from './csrf.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionData & { sessionId: string };
  }
}

/**
 * A `preHandler`, not a global `onRequest` hook -- authentication in this
 * API is opt-in per route (`{ preHandler: requireAuth }`), not applied
 * blanket to every request. Section 21's flow: cookie -> Node.js -> Redis
 * -> session:{sessionId} -> userId -> Postgres if needed. The Postgres
 * step only happens where a route actually needs full user data (e.g.
 * GET /me); routes that only need userId/role read them straight off the
 * Redis hash without an extra database round trip.
 */
async function resolveSession(request: FastifyRequest): Promise<boolean> {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) {
    return false;
  }

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) {
    return false;
  }

  const sessionId = unsigned.value;
  // Session data lives ONLY in Redis (packages/redis's session hash) --
  // unlike the seat-lock/rate-limit/cache reads elsewhere in this
  // codebase, there is no fail-open fallback possible here: this API has
  // no way to know who's asking without it. A thrown error here (Redis
  // genuinely unreachable, now bounded by commandTimeout instead of
  // hanging -- see packages/redis/src/client.ts) is deliberately mapped
  // to a real ServiceUnavailableError (503) rather than left to fall
  // through to error-handler.ts's generic 500 catch-all: this is a known
  // dependency outage, not an unexplained application bug, and the
  // client-visible distinction matters (retry shortly, vs. something is
  // actually broken).
  let session: SessionData | null;
  try {
    session = await getSession(request.server.redis, sessionId);
  } catch {
    throw new ServiceUnavailableError('Unable to verify your session right now. Please try again shortly.');
  }
  if (!session) {
    return false;
  }

  // Fire-and-forget: this write updating an activity timestamp must never
  // block or fail the request it's piggybacking on. If Redis hiccups on
  // this specific write, the user's request should still succeed --
  // failing to record "was recently active" is not a reason to reject an
  // otherwise-valid, already-verified session.
  void touchSessionIfStale(request.server.redis, sessionId, session).catch((err: unknown) => {
    request.log.warn({ err, sessionId }, 'failed to refresh session activity timestamp');
  });

  request.session = { ...session, sessionId };
  return true;
}

/**
 * `optionalAuth` deliberately does NOT call `verifyCsrf` -- every current
 * caller of `optionalAuth` is a GET route (event listing/detail), and
 * CSRF has nothing to protect on a read. Only `requireAuth`-protected
 * routes -- where a valid session is REQUIRED, which in practice means
 * every state-changing endpoint in this API -- enforce it. See
 * plugins/csrf.ts for why safe methods (GET/HEAD/OPTIONS) are skipped
 * even here.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const found = await resolveSession(request);
  if (!found) {
    throw new UnauthorizedError();
  }
  verifyCsrf(request, getSessionOrThrow(request).sessionId);
}

/**
 * Populates `request.session` when a valid cookie is present, but never
 * throws when one isn't -- for routes serving BOTH public and
 * authenticated callers differently (e.g. event listing: everyone sees
 * PUBLISHED events, but an ADMIN's session unlocks every status). Route
 * handlers check `request.session?.role` themselves rather than calling
 * `getSessionOrThrow`, since "no session" is a valid, expected outcome
 * here, not an error.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await resolveSession(request);
}

/**
 * Narrows `request.session` from optional to required for handlers
 * registered with `{ preHandler: requireAuth }` -- requireAuth always
 * sets it or throws first, so any handler reaching this point already
 * has one, but TypeScript can't see that connection across two separate
 * functions. This is the one place that gap is bridged, so route
 * handlers never need a non-null assertion of their own.
 */
export function getSessionOrThrow(
  request: FastifyRequest,
): SessionData & { sessionId: string } {
  if (!request.session) {
    throw new UnauthorizedError();
  }
  return request.session;
}
