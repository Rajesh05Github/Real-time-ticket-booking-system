import { consumeRateLimit, redisKeys } from '@flashsale/redis';
import { RateLimitError, type RateLimitBucket } from '@flashsale/shared';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `rateLimit(RATE_LIMIT_LOGIN)` returns a preHandler that caps requests
 * per `request.ip` against the given bucket (section 20). Composed onto
 * a route's preHandler array the same way `requireRole(...)` is (see
 * rbac.ts) -- and, per that file's hard-won lesson, declared `async` even
 * though its own body has exactly one `await`, so it's never the sync
 * function that ends up sitting after an async one in a mixed array.
 *
 * Keyed by `request.ip`, not by an authenticated user id: these routes
 * (register/login/resend-otp/verify-otp) are exactly the ones a caller
 * hits BEFORE having any session, so there's no user identity yet to key
 * on. `request.ip` is only trustworthy because app.ts sets
 * `trustProxy: true` -- without that, every request arriving through
 * Nginx would report Nginx's own container IP, and every caller would
 * share one bucket.
 */
export function rateLimit(config: RateLimitBucket) {
  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = redisKeys.rateLimit(config.bucket, request.ip);
    const result = await consumeRateLimit(request.server.redis, key, config.limit, config.windowSeconds);

    if (!result.allowed) {
      reply.header('Retry-After', result.retryAfterSeconds.toString());
      throw new RateLimitError('Too many requests. Please try again later.', result.retryAfterSeconds);
    }
  };
}
