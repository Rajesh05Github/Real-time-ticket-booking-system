import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';
import { requireRole } from '../../plugins/rbac.js';

import { createSectionSchema, createVenueSchema, venueIdParamsSchema } from './venue.schema.js';
import * as venueService from './venue.service.js';

import type { FastifyInstance } from 'fastify';

const adminOnly = [requireAuth, requireRole('ADMIN')];

export function venueRoutes(app: FastifyInstance): void {
  app.post('/', { preHandler: adminOnly }, async (request, reply) => {
    const body = createVenueSchema.parse(request.body);
    const session = getSessionOrThrow(request);
    const venue = await venueService.createVenue(session.userId, body);
    reply.status(201).send(apiSuccess(venue));
  });

  app.get('/', { preHandler: adminOnly }, async (_request, reply) => {
    const venues = await venueService.listVenues();
    reply.status(200).send(apiSuccess(venues));
  });

  app.post('/:venueId/sections', { preHandler: adminOnly }, async (request, reply) => {
    const { venueId } = venueIdParamsSchema.parse(request.params);
    const body = createSectionSchema.parse(request.body);
    const session = getSessionOrThrow(request);
    const section = await venueService.createSection(session.userId, venueId, body.name);
    reply.status(201).send(apiSuccess(section));
  });

  app.get('/:venueId/sections', { preHandler: adminOnly }, async (request, reply) => {
    const { venueId } = venueIdParamsSchema.parse(request.params);
    await venueService.getVenueOrThrow(venueId);
    const sections = await venueService.listSectionsByVenue(venueId);
    reply.status(200).send(apiSuccess(sections));
  });
}
