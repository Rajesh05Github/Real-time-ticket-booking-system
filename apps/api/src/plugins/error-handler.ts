import { AppError, apiFailure, InternalServerError } from '@flashsale/shared';
import { ZodError } from 'zod';

import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Centralized error handler (section 34).
 *
 * The rule this enforces: NOTHING downstream of a route handler should ever
 * hand-format an error response. A route either returns data, or throws --
 * this hook is the single place that decides what the client sees. That's
 * what guarantees the "never expose internal stack traces in production"
 * requirement actually holds everywhere, instead of depending on every
 * route author remembering it.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    const requestId = request.id;

    // Known, deliberately-thrown application error: trust its message/code,
    // it was written to be shown to a client.
    if (error instanceof AppError) {
      if (error.httpStatus >= 500) {
        request.log.error({ err: error, requestId }, error.message);
      } else {
        request.log.warn({ err: error, code: error.code, requestId }, error.message);
      }

      reply
        .status(error.httpStatus)
        .send(apiFailure(error.code, error.message, error.details, requestId));
      return;
    }

    // Zod validation errors thrown outside a schema-validated route (e.g.
    // manual parsing in a service) get mapped the same way as fastify's
    // native schema validation errors below.
    if (error instanceof ZodError) {
      request.log.warn({ err: error, requestId }, 'validation failed');
      reply.status(400).send(
        apiFailure(
          'VALIDATION_ERROR',
          'Request validation failed',
          { issues: error.issues },
          requestId,
        ),
      );
      return;
    }

    // Fastify's own schema-validation failures (when a route uses a JSON
    // schema directly rather than Zod).
    if (error.validation) {
      request.log.warn({ err: error, requestId }, 'schema validation failed');
      reply
        .status(400)
        .send(apiFailure('VALIDATION_ERROR', error.message, { validation: error.validation }, requestId));
      return;
    }

    // Fastify's OWN built-in request-parsing errors (an empty body sent
    // with a JSON content-type, malformed JSON, an unsupported
    // content-type, a body over the configured bodyLimit, ...) carry a
    // real 4xx statusCode of their own -- e.g. FST_ERR_CTP_EMPTY_JSON_BODY
    // sets statusCode: 400. Without this branch, EVERY one of those fell
    // all the way through to the generic 500 below, turning an ordinary
    // client mistake (a malformed request) into a misleading "Internal
    // Server Error." Found live by Phase 18's load-testing setup script
    // accidentally sending `Content-Type: application/json` with no body
    // on a request that doesn't need one -- a real client bug, that a
    // real server bug then reported as the wrong kind of error.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error, requestId }, error.message);
      reply
        .status(error.statusCode)
        .send(apiFailure(error.code ?? 'BAD_REQUEST', error.message, undefined, requestId));
      return;
    }

    // Anything else is a bug, not a handled case. Log the full detail
    // server-side; the client gets a generic, non-leaky message.
    request.log.error({ err: error, requestId }, 'unhandled error');
    const internal = new InternalServerError();
    reply.status(internal.httpStatus).send(apiFailure(internal.code, internal.message, undefined, requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(apiFailure('NOT_FOUND', `Route ${request.method} ${request.url} not found`, undefined, request.id));
  });
}
