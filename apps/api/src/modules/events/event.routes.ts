import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, optionalAuth, requireAuth } from '../../plugins/auth-hook.js';
import { requireRole } from '../../plugins/rbac.js';

import {
  createEventSchema,
  eventIdParamsSchema,
  listEventsQuerySchema,
  trendingQuerySchema,
  updateEventSchema,
} from './event.schema.js';
import * as eventService from './event.service.js';

import type { FastifyInstance } from 'fastify';

const adminOnly = [requireAuth, requireRole('ADMIN')];

export function eventRoutes(app: FastifyInstance): void {
  app.post('/', { preHandler: adminOnly }, async (request, reply) => {
    const body = createEventSchema.parse(request.body);
    const session = getSessionOrThrow(request);
    const event = await eventService.createEvent(session.userId, body);
    reply.status(201).send(apiSuccess(event));
  });

  // optionalAuth, not requireAuth: an anonymous browser and a logged-in
  // ADMIN hit the SAME route with different visibility, not two separate
  // endpoints -- see event.service.ts's listEvents/getEventForViewer for
  // why that's the right split rather than an /admin-prefixed duplicate.
  app.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    const query = listEventsQuerySchema.parse(request.query);
    const { events, total, page, pageSize } = await eventService.listEvents(
      app.redis,
      request.session?.role,
      query,
    );
    reply.status(200).send(apiSuccess(events, { page, pageSize, total }));
  });

  // Registered as a static path ahead of the parametric /:eventId routes
  // below purely for readability -- Fastify's router (find-my-way)
  // already prioritizes static segments over parametric ones regardless
  // of registration order, so `/trending` was never at risk of being
  // swallowed by `/:eventId`, but reading top-to-bottom this way avoids
  // any doubt about it.
  app.get('/trending', async (request, reply) => {
    const { limit } = trendingQuerySchema.parse(request.query);
    const events = await eventService.getTrendingEvents(app.redis, limit);
    reply.status(200).send(apiSuccess(events));
  });

  app.get('/:eventId', { preHandler: optionalAuth }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const event = await eventService.getEventForViewer(app.redis, eventId, request.session?.role);
    reply.status(200).send(apiSuccess(event));
  });

  app.patch('/:eventId', { preHandler: adminOnly }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const body = updateEventSchema.parse(request.body);
    const session = getSessionOrThrow(request);
    const event = await eventService.updateEvent(app.redis, session.userId, eventId, body);
    reply.status(200).send(apiSuccess(event));
  });

  app.post('/:eventId/publish', { preHandler: adminOnly }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const event = await eventService.publishEvent(app.redis, session.userId, eventId);
    reply.status(200).send(apiSuccess(event));
  });

  app.post('/:eventId/unpublish', { preHandler: adminOnly }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const event = await eventService.unpublishEvent(app.redis, session.userId, eventId);
    reply.status(200).send(apiSuccess(event));
  });

  app.post('/:eventId/watch', { preHandler: requireAuth }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    await eventService.watchEvent(app.redis, eventId, session.userId, session.role);
    reply.status(200).send(apiSuccess({ watching: true }));
  });

  app.delete('/:eventId/watch', { preHandler: requireAuth }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    await eventService.unwatchEvent(app.redis, eventId, session.userId, session.role);
    reply.status(200).send(apiSuccess({ watching: false }));
  });

  app.get('/:eventId/watch', { preHandler: requireAuth }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const status = await eventService.getWatchStatus(app.redis, eventId, session.userId, session.role);
    reply.status(200).send(apiSuccess(status));
  });
}
