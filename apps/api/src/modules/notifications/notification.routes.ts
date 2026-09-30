import { getRecentFeed } from '@flashsale/redis';
import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';

import type { FastifyInstance } from 'fastify';

export function notificationRoutes(app: FastifyInstance): void {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    const feed = await getRecentFeed(app.redis, session.userId);
    reply.status(200).send(apiSuccess(feed));
  });
}
