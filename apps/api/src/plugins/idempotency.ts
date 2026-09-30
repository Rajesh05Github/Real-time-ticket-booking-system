import { createHash } from 'node:crypto';

import { Prisma, prisma } from '@flashsale/database';
import { DomainBadRequestError, DomainConflictError } from '@flashsale/shared';
import fp from 'fastify-plugin';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by `idempotencyGuard(...)` when a fresh (not-yet-seen)
     * Idempotency-Key was accepted for this request -- the app-level
     * hooks below check this to know whether they own persisting this
     * response into idempotency_keys. Absent for every route that
     * doesn't use idempotencyGuard, which is the normal case.
     */
    idempotencyRecordId?: string;
    /** Captured by onSend, consumed by onResponse -- see the comment on
     * registerIdempotencyPersistence for why the DB write itself happens
     * in onResponse rather than here. */
    idempotencyResponsePayload?: string | undefined;
  }
}

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/**
 * Registers the app-wide hooks that persist an idempotent response
 * (section 22). Registered once in app.ts, not per-route --
 * `idempotencyGuard` below only decorates `request.idempotencyRecordId`;
 * this is what turns that decoration into a stored, replayable result.
 *
 * Split across TWO hooks, deliberately:
 *
 *  - `onSend` only captures the serialized payload into a request
 *    property, synchronously, with no `await` anywhere in it. A live
 *    Docker test caught a real bug here: an EARLIER version did the
 *    actual Prisma write inside `onSend` and awaited it there. That
 *    write succeeded and the client's response body was intact, but
 *    Fastify still logged "Reply was already sent" /
 *    ERR_HTTP_HEADERS_SENT immediately afterward for every request --
 *    an onSend hook that does slow async work after the point Fastify
 *    considers the send "finished enough" to move on conflicts with its
 *    own reply-lifecycle bookkeeping. onSend hooks in this codebase are
 *    for transforming/observing the payload cheaply and synchronously,
 *    not for I/O.
 *  - `onResponse` -- which fires strictly AFTER the response has been
 *    fully flushed to the client and never touches the reply object at
 *    all -- is where the actual database write happens. This is the
 *    same hook app.ts's own request-logging already uses for exactly
 *    this reason.
 *
 * Keyed off the final status code, not the route: a >=500 response is
 * assumed to be a transient/unexpected failure (a bug, a dependency
 * outage) and its IN_PROGRESS row is deleted rather than completed, so a
 * client retry with the SAME Idempotency-Key can actually retry the real
 * work. Anything below 500 -- a 201 success just as much as a 409
 * SEAT_NOT_AVAILABLE -- is a deterministic outcome of THIS request's
 * input and is exactly what a repeat of the same key+body should keep
 * getting back, so it's persisted as COMPLETED.
 */
export function registerIdempotencyPersistence(app: FastifyInstance): void {
  // async despite no `await` -- every hook in this codebase is, on
  // principle (see rbac.ts). Doubly deliberate here: this hook's entire
  // point is to do NOTHING async, so there's no risk of ever needing one.
  app.addHook('onSend', async (request: FastifyRequest, _reply: FastifyReply, payload) => {
    if (request.idempotencyRecordId) {
      request.idempotencyResponsePayload = typeof payload === 'string' ? payload : undefined;
    }
    return payload;
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const recordId = request.idempotencyRecordId;
    if (!recordId) {
      return;
    }

    // Persisting the idempotency record is a SIDE CHANNEL to the
    // already-completed response, not part of it -- a failure here must
    // never propagate anywhere the client would see it.
    try {
      if (reply.statusCode >= 500) {
        await prisma.idempotencyKey.delete({ where: { id: recordId } });
        return;
      }

      // Captured by onSend above, already the fully-serialized JSON
      // string -- parsed back to a plain value so it round-trips through
      // Prisma's `Json` column, and re-parsed the same way on replay.
      const raw = request.idempotencyResponsePayload;
      const responseBody = raw !== undefined ? (JSON.parse(raw) as Prisma.InputJsonValue) : null;

      await prisma.idempotencyKey.update({
        where: { id: recordId },
        data: {
          status: 'COMPLETED',
          responseStatus: reply.statusCode,
          responseBody: responseBody ?? Prisma.JsonNull,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      request.log.error({ err }, 'failed to persist idempotency record');
    }
  });
}

export const idempotencyPlugin = fp((app: FastifyInstance) => {
  registerIdempotencyPersistence(app);
});

/**
 * `idempotencyGuard('POST /reservations')` returns a preHandler enforcing
 * that every request to this route carries an Idempotency-Key header
 * (required, not optional -- this guards the exact "double-click /
 * network-retry double-books a seat" scenario section 22 was written
 * for, so silently skipping the check when the header is absent would
 * defeat the point).
 *
 * The INSERT into idempotency_keys is itself the lock: `@@unique([route,
 * key])` means two concurrent requests carrying the same key can't both
 * succeed at creating the IN_PROGRESS row -- exactly one does, and that's
 * what actually closes the "two simultaneous double-clicks both see no
 * existing key" race a naive SELECT-then-INSERT would miss (the same
 * unique-index-as-lock pattern reservation_items uses one layer down).
 */
export function idempotencyGuard(route: string) {
  // async despite no top-level await needed for correctness -- every
  // preHandler in this codebase is async on principle, see rbac.ts's
  // comment on the Fastify preHandler-array hang this avoids.
  return async function idempotencyHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new DomainBadRequestError(
        'IDEMPOTENCY_KEY_REQUIRED',
        `An ${IDEMPOTENCY_KEY_HEADER} header is required for this request.`,
      );
    }

    const requestHash = hashBody(request.body);

    try {
      const record = await prisma.idempotencyKey.create({
        data: { key, route, requestHash, status: 'IN_PROGRESS' },
      });
      request.idempotencyRecordId = record.id;
      return;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
    }

    // Lost the INSERT race (or this is a genuine retry) -- the existing
    // row, not this request, is authoritative on what happens next.
    const existing = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { route_key: { route, key } },
    });

    if (existing.requestHash !== requestHash) {
      throw new DomainConflictError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body.',
      );
    }

    if (existing.status === 'IN_PROGRESS') {
      throw new DomainConflictError(
        'REQUEST_IN_PROGRESS',
        'An identical request is already being processed.',
      );
    }

    // COMPLETED: replay the exact response this key produced the first
    // time, without re-running the route handler at all -- sending here,
    // in the preHandler, short-circuits Fastify's normal handler dispatch
    // (a preHandler that calls reply.send() skips the route handler).
    reply.status(existing.responseStatus ?? 200).send(existing.responseBody);
  };
}
