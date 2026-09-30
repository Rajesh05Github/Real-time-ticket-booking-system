import { ForbiddenError } from '@flashsale/shared';

import { getSessionOrThrow } from './auth-hook.js';

import type { UserRole } from '@flashsale/database';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `requireRole('ADMIN')` returns a preHandler; it does NOT verify a
 * session exists itself -- it's always composed AFTER `requireAuth` in a
 * route's preHandler array (`[requireAuth, requireRole('ADMIN')]`), which
 * is what actually populates `request.session`. Splitting authentication
 * (who are you) from authorization (what are you allowed to do) into two
 * separate, composable hooks means a route needing "any logged-in user"
 * uses just `requireAuth`, and one needing "an admin" adds this on top,
 * rather than one monolithic hook trying to handle every combination.
 *
 * `getSessionOrThrow` throws UnauthorizedError (401) if requireAuth
 * somehow wasn't run first -- a route wiring bug, not a client error --
 * so misconfiguring the preHandler order fails loudly instead of
 * silently allowing an unauthenticated request through.
 *
 * `roleGuard` is declared `async` despite doing nothing that awaits --
 * this is load-bearing, not stylistic. A route's preHandler ARRAY here
 * mixes an async hook (requireAuth) with what was originally a plain
 * synchronous one (this function). Under Fastify 5.12.1, a sync
 * function positioned after an async one in a preHandler array hangs
 * the request indefinitely on the SUCCESS path (it throwing still
 * worked correctly -- only the "let the request through" path hung),
 * with no error, no log line, nothing -- confirmed by bisection against
 * a live container: replacing the route handler's body with a static
 * response still hung, and the fix was exactly this one keyword. Every
 * hook composed into a preHandler array in this codebase should be
 * `async`, even ones with nothing to await, to avoid hitting this again.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  // The `async` keyword below has no `await` inside because it isn't
  // needed for this function's own logic -- it's required to avoid the
  // Fastify preHandler-array hang documented in the comment above.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function roleGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = getSessionOrThrow(request);
    if (!allowedRoles.includes(session.role)) {
      throw new ForbiddenError();
    }
  };
}
