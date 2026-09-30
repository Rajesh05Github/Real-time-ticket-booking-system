import { apiSuccess } from '@flashsale/shared';

import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';
import { idempotencyGuard } from '../../plugins/idempotency.js';

import { createOrderSchema, orderIdParamsSchema } from './order.schema.js';
import * as orderService from './order.service.js';

import type { FastifyInstance } from 'fastify';

const ROUTE_CREATE_ORDER = 'POST /orders';
const ROUTE_RETRY_PAYMENT = 'POST /orders/:orderId/retry-payment';
const ROUTE_CANCEL_ORDER = 'POST /orders/:orderId/cancel';

export function orderRoutes(app: FastifyInstance): void {
  app.post('/', { preHandler: [requireAuth, idempotencyGuard(ROUTE_CREATE_ORDER)] }, async (request, reply) => {
    const body = createOrderSchema.parse(request.body);
    const session = getSessionOrThrow(request);
    const order = await orderService.createOrder(app.paymentProvider, session.userId, body.reservationId);
    reply.status(201).send(apiSuccess(order));
  });

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    const orders = await orderService.listMyOrders(session.userId);
    reply.status(200).send(apiSuccess(orders));
  });

  app.get('/:orderId', { preHandler: requireAuth }, async (request, reply) => {
    const { orderId } = orderIdParamsSchema.parse(request.params);
    const session = getSessionOrThrow(request);
    const order = await orderService.getOrderForUser(orderId, session.userId, session.role);
    reply.status(200).send(apiSuccess(order));
  });

  app.post(
    '/:orderId/retry-payment',
    { preHandler: [requireAuth, idempotencyGuard(ROUTE_RETRY_PAYMENT)] },
    async (request, reply) => {
      const { orderId } = orderIdParamsSchema.parse(request.params);
      const session = getSessionOrThrow(request);
      const order = await orderService.retryPayment(app.paymentProvider, session.userId, orderId);
      reply.status(200).send(apiSuccess(order));
    },
  );

  // Cancels a checkout in progress (PENDING) or a completed booking
  // (PAID -> tickets cancelled, seats released, refund queued). See
  // order.service.ts's cancelOrder.
  app.post(
    '/:orderId/cancel',
    { preHandler: [requireAuth, idempotencyGuard(ROUTE_CANCEL_ORDER)] },
    async (request, reply) => {
      const { orderId } = orderIdParamsSchema.parse(request.params);
      const session = getSessionOrThrow(request);
      const order = await orderService.cancelOrder(orderId, session.userId, session.role);
      reply.status(200).send(apiSuccess(order));
    },
  );
}
