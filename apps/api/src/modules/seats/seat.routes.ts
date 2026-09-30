import { apiSuccess, NotFoundError } from '@flashsale/shared';

import { getSessionOrThrow, optionalAuth, requireAuth } from '../../plugins/auth-hook.js';
import { requireRole } from '../../plugins/rbac.js';
import { seatGenerationQueue } from '../../queues/seat-generation-queue.js';

import {
  eventIdParamsSchema,
  generateSeatsSchema,
  generationJobParamsSchema,
} from './seat.schema.js';
import * as seatService from './seat.service.js';

import type { FastifyInstance } from 'fastify';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * Registered as a nested prefix under events (see app.ts:
 * `/api/v1/events/:eventId/seats`) -- seats are always scoped to one
 * event (schema.prisma's Seat.eventId), never listed or created
 * independently of it.
 */
export function seatRoutes(app: FastifyInstance): void {
  app.post('/:eventId/seats', { preHandler: adminOnly }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const body = generateSeatsSchema.parse(request.body);
    const session = getSessionOrThrow(request);

    const result = await seatService.generateSeats(session.userId, eventId, body.assignments);

    if (result.mode === 'sync') {
      reply.status(201).send(apiSuccess({ mode: result.mode, seats: result.seats }));
      return;
    }

    // 202 Accepted, not 201: nothing has been created yet at response
    // time -- the client polls the job-status route below to find out
    // when (and whether) it has.
    reply.status(202).send(apiSuccess({ mode: result.mode, jobId: result.jobId }));
  });

  app.get('/:eventId/seats', { preHandler: adminOnly }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const seats = await seatService.listSeatsForEvent(eventId);
    reply.status(200).send(apiSuccess(seats));
  });

  /**
   * The PUBLIC counterpart to the admin route above -- a sibling path,
   * not a preHandler swap on the same route: this returns a DIFFERENT
   * shape (section-grouped, aggregate counts, no raw `Seat[]`) for a
   * DIFFERENT audience (anyone who can see the event at all, via
   * `optionalAuth` + the same PUBLISHED-or-admin visibility rule
   * `assertEventVisibleToViewer` enforces for the REST event-detail
   * route). Conflating the two into one route would force a choice
   * between an admin's raw-rows shape and a customer's grouped shape --
   * see seat.service.ts's `getSeatAvailability` for the rest of the
   * reasoning, including why this is deliberately UNCACHED.
   */
  app.get('/:eventId/seats/availability', { preHandler: optionalAuth }, async (request, reply) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const availability = await seatService.getSeatAvailability(eventId, request.session?.role);
    reply.status(200).send(apiSuccess(availability));
  });

  app.get(
    '/:eventId/seats/generation-jobs/:jobId',
    { preHandler: adminOnly },
    async (request, reply) => {
      const { jobId } = generationJobParamsSchema.parse(request.params);

      // Queried directly from BullMQ's own job state (Queue.getJob +
      // job.getState()/progress) rather than a custom progress-tracking
      // table -- BullMQ already persists exactly this in Redis for the
      // lifetime of the job, so a parallel table would just be a second,
      // harder-to-keep-consistent copy of the same information.
      const job = await seatGenerationQueue.getJob(jobId);
      if (!job) {
        throw new NotFoundError('Generation job');
      }

      const state = await job.getState();
      reply.status(200).send(
        apiSuccess({
          jobId: job.id,
          state,
          progress: job.progress,
          failedReason: job.failedReason,
        }),
      );
    },
  );
}
