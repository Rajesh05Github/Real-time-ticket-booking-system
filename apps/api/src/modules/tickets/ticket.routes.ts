import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';

import { ticketIdParamsSchema } from './ticket.schema.js';
import * as ticketService from './ticket.service.js';

import type { FastifyInstance } from 'fastify';

export function ticketRoutes(app: FastifyInstance): void {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    const tickets = await ticketService.listMyTickets(session.userId);
    reply.status(200).send(apiSuccess(tickets));
  });

  app.get('/:ticketId', { preHandler: requireAuth }, async (request, reply) => {
    const { ticketId } = ticketIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const ticket = await ticketService.getTicketForUser(ticketId, session.userId, session.role);
    reply.status(200).send(apiSuccess(ticket));
  });
}
