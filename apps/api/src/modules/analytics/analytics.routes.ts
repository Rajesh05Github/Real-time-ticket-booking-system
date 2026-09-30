import { redisKeys } from '@flashsale/redis';
import { apiSuccess } from '@flashsale/shared';

import { requireAuth } from '../../plugins/auth-hook.js';
import { requireRole } from '../../plugins/rbac.js';

import type { FastifyInstance } from 'fastify';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * Phase 16's read side: the two Redis Hashes apps/worker's analytics
 * consumer maintains, exposed as one admin-only summary. Deliberately a
 * thin, direct HGETALL -- this route does no aggregation of its own; the
 * consumer is the only writer, so reading is just "return what's
 * there," same division of responsibility as every other cache-style
 * read in this codebase (e.g. event-cache.ts's cache-aside read).
 *
 * amountMinor values stay strings all the way out (HGETALL returns
 * strings, and this route doesn't convert them to `number`) --
 * consistent with the rest of this codebase's bigint-as-string wire
 * convention, and avoids the exact precision-loss risk
 * analytics-consumer.ts's own comment calls out for the write side.
 */
export function analyticsRoutes(app: FastifyInstance): void {
  app.get('/summary', { preHandler: adminOnly }, async (_request, reply) => {
    const [eventCounts, revenueMinorByCurrency] = await Promise.all([
      app.redis.hgetall(redisKeys.analyticsEventCounts()),
      app.redis.hgetall(redisKeys.analyticsRevenueByCurrency()),
    ]);

    reply.status(200).send(apiSuccess({ eventCounts, revenueMinorByCurrency }));
  });
}
