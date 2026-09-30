import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { prisma } from '@flashsale/database';
import { createLogger } from '@flashsale/logger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { env } from './env.js';
import { analyticsRoutes } from './modules/analytics/analytics.routes.js';
import { authRoutes, meRoutes } from './modules/auth/auth.routes.js';
import { eventLiveRoutes } from './modules/events/event-live.routes.js';
import { eventRoutes } from './modules/events/event.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { notificationRoutes } from './modules/notifications/notification.routes.js';
import { orderRoutes } from './modules/orders/order.routes.js';
import { paymentRoutes } from './modules/payments/payment.routes.js';
import { reservationRoutes } from './modules/reservations/reservation.routes.js';
import { seatRoutes } from './modules/seats/seat.routes.js';
import { ticketRoutes } from './modules/tickets/ticket.routes.js';
import { venueRoutes } from './modules/venues/venue.routes.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { liveBroadcastPlugin } from './plugins/live-broadcast.js';
import { paymentProviderPlugin } from './plugins/payment-provider.js';
import { redisPlugin } from './plugins/redis.js';
import { emailQueue } from './queues/email-queue.js';
import { reservationExpiryQueue } from './queues/reservation-expiry-queue.js';
import { seatGenerationQueue } from './queues/seat-generation-queue.js';

/**
 * Builds (but does not start) the Fastify instance.
 *
 * Split from server.ts deliberately: tests import `buildApp()` and use
 * `.inject()` for fast in-process HTTP testing without binding a real port
 * (see section 45 API tests, built out from Phase 4 onward).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const logger = createLogger({
    service: 'api',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const app = Fastify({
    // Cast needed: @flashsale/logger returns a real pino.Logger, which is
    // structurally compatible with Fastify's FastifyBaseLogger at runtime,
    // but under this repo's `exactOptionalPropertyTypes: true` the two
    // declared types disagree on the optional `msgPrefix` getter. Without
    // the cast, that single mismatch propagates through every method that
    // touches the instance's generic logger type (route registration, the
    // error handler's inferred error type, etc.) turning unrelated code
    // red. The cast scopes the workaround to exactly this boundary.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Every request gets a correlation ID. If the client sends X-Request-ID
    // we keep it (lets a load test or upstream gateway trace end-to-end);
    // otherwise we generate one. This ID is threaded into job payloads and
    // outbox events in later phases so one reservation can be traced
    // api -> outbox -> stream -> worker -> email (section 36).
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    // `disableRequestLogging: true` turns off Fastify's OWN built-in
    // request/response log lines -- without it, every request would be
    // logged twice: once by Fastify's default and again by our `onResponse`
    // hook below, which adds the fields (route, durationMs) section 35
    // actually requires. `requestIdLogLabel` still applies to the log
    // lines Fastify itself emits outside that hook (startup, deprecation
    // warnings, the 404 handler's own info log, etc.).
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: true,
    }),
    trustProxy: true, // required for correct client IP behind Nginx (section 20 rate limiting)
    bodyLimit: 1_048_576, // 1MB - section 46 request size limits
  });

  await app.register(helmet, {
    // CSP is enforced by the Next.js app itself; the API returns JSON only.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true, // required to send/receive the HttpOnly session cookie
  });

  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
    hook: 'onRequest',
  });

  // Must be registered before any `{ websocket: true }` route -- it's
  // what teaches Fastify's router that option exists at all.
  await app.register(websocket);

  registerErrorHandler(app);

  await app.register(redisPlugin);
  await app.register(idempotencyPlugin);
  await app.register(paymentProviderPlugin);
  await app.register(liveBroadcastPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(meRoutes, { prefix: '/api/v1' });
  await app.register(venueRoutes, { prefix: '/api/v1/venues' });
  await app.register(eventRoutes, { prefix: '/api/v1/events' });
  // seatRoutes' own paths already start with /:eventId/seats, so this
  // prefix produces /api/v1/events/:eventId/seats -- seats are always
  // nested under the event they belong to (schema.prisma's Seat.eventId),
  // never a standalone top-level resource.
  await app.register(seatRoutes, { prefix: '/api/v1/events' });
  await app.register(eventLiveRoutes, { prefix: '/api/v1/events' });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await app.register(reservationRoutes, { prefix: '/api/v1/reservations' });
  await app.register(orderRoutes, { prefix: '/api/v1/orders' });
  await app.register(paymentRoutes, { prefix: '/api/v1/payments' });
  await app.register(ticketRoutes, { prefix: '/api/v1/tickets' });
  await app.register(analyticsRoutes, { prefix: '/api/v1/analytics' });

  // Prisma and the email queue's Redis connection are module-level
  // singletons (packages/database/src/client.ts, src/queues/email-queue.ts)
  // rather than Fastify decorations, since apps/worker shares the same
  // Prisma singleton pattern without a Fastify instance to hang it off
  // of. Closing them here -- as Fastify onClose hooks -- keeps their
  // shutdown ordered correctly relative to draining in-flight requests:
  // onClose hooks run after the HTTP listener stops accepting new
  // connections but as part of app.close(), which shutdown.ts already
  // awaits before the process exits.
  //
  // reservationExpiryQueue (Phase 12) belongs in this same list -- its
  // absence until now was a real gap this phase's own app.ts changes
  // happened to surface: every OTHER BullMQ Queue this app creates was
  // already closed here, and that one silently wasn't.
  app.addHook('onClose', async () => {
    // BullMQ's Queue.close() waits for its Redis connection to be ready
    // before closing gracefully -- if Redis is unreachable AT SHUTDOWN
    // TIME, that wait never resolves on its own. Racing it against a
    // short timeout means a stuck dependency degrades shutdown speed
    // instead of blocking it outright; shutdown.ts's SHUTDOWN_TIMEOUT_MS
    // is the outer safety net if even this races long.
    await Promise.race([
      Promise.all([emailQueue.close(), seatGenerationQueue.close(), reservationExpiryQueue.close()]),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    await prisma.$disconnect();
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request completed',
    );
  });

  return app;
}
