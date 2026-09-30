import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';
import { idempotencyGuard } from '../../plugins/idempotency.js';

import { createReservationSchema, reservationIdParamsSchema } from './reservation.schema.js';
import * as reservationService from './reservation.service.js';

import type { FastifyInstance } from 'fastify';

const ROUTE_CREATE_RESERVATION = 'POST /reservations';

export function reservationRoutes(app: FastifyInstance): void {
  app.post(
    '/',
    { preHandler: [requireAuth, idempotencyGuard(ROUTE_CREATE_RESERVATION)] },
    async (request, reply) => {
      const body = createReservationSchema.parse(request.body);
      const session = getSessionOrThrow(request);
      const reservation = await reservationService.createReservation(
        app.redis,
        session.userId,
        body.eventId,
        body.seatIds,
      );
      reply.status(201).send(apiSuccess(reservation));
    },
  );

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    const reservations = await reservationService.listMyReservations(session.userId);
    reply.status(200).send(apiSuccess(reservations));
  });

  app.get('/:reservationId', { preHandler: requireAuth }, async (request, reply) => {
    const { reservationId } = reservationIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const reservation = await reservationService.getReservationForUser(
      reservationId,
      session.userId,
      session.role,
    );
    reply.status(200).send(apiSuccess(reservation));
  });

  app.delete('/:reservationId', { preHandler: requireAuth }, async (request, reply) => {
    const { reservationId } = reservationIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    await reservationService.cancelReservation(reservationId, session.userId);
    reply.status(200).send(apiSuccess({ cancelled: true }));
  });
}
