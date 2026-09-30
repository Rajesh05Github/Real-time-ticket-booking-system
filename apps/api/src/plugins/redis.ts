import { createRedisClient, type Redis } from '@flashsale/redis';
import fp from 'fastify-plugin';

import { env } from '../env.js';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

/**
 * Decorates the Fastify instance with one shared Redis client (session
 * lookup, OTP storage, and everything Phase 7+ adds) and closes it during
 * graceful shutdown via Fastify's onClose hook -- registered here, not in
 * shutdown.ts, so the Redis client's lifecycle is owned by the plugin
 * that created it rather than threaded through as a separate global.
 *
 * `fastify-plugin` is required, not optional style: without it, Fastify
 * encapsulates decorators to the plugin's own scope by default, and
 * `app.redis` would be invisible to routes registered as sibling plugins
 * (i.e. every route in this app).
 */
export const redisPlugin = fp((app: FastifyInstance) => {
  // commandTimeout: a request-path client, never a long-blocking one
  // (unlike apps/worker's stream consumers) -- see
  // packages/redis/src/client.ts for why this is opt-in per call site,
  // and docs/failure-testing.md for the live Redis-outage test that
  // found the indefinite hang this fixes.
  const redis = createRedisClient(env.REDIS_URL, { commandTimeout: 2000 });

  redis.on('error', (err) => {
    app.log.error({ err }, 'redis client error');
  });

  app.decorate('redis', redis);

  app.addHook('onClose', () => {
    // .disconnect(), NOT .quit(): quit() sends a QUIT command over the
    // live connection and waits for it to complete, which means it can
    // hang indefinitely if the client is mid-reconnect-retry against a
    // Redis that's down AT SHUTDOWN TIME -- exactly the situation
    // graceful shutdown (section 37) needs to be robust to, not blocked
    // by. disconnect() tears down immediately regardless of connection
    // state. shutdown.ts's SHUTDOWN_TIMEOUT_MS is the other half of this
    // safety net for anything else that might stall.
    redis.disconnect();
  });
});
