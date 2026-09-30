import { createHash } from 'node:crypto';

import { Prisma } from '@flashsale/database';
import { apiSuccess } from '@flashsale/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DatabaseModule from '@flashsale/database';

// vi.mock(...) below is hoisted to the top of the file by Vitest, above
// any top-level `const` -- referencing a plain `const idempotencyKey`
// from inside the factory would throw "Cannot access before
// initialization". `vi.hoisted` runs its own initializer at that same
// hoisted point, which is what makes it safe to reference here.
//
// Deliberately untyped `vi.fn()` (not `vi.fn<...>()`) -- giving these a
// precise signature fights every test's differently-shaped fixture
// (a COMPLETED record vs an IN_PROGRESS one vs a fresh { id }) and, worse,
// makes `expect.any(...)`/`expect.objectContaining(...)` -- both typed
// `any` by vitest -- trip `no-unsafe-assignment` the moment they're
// assigned into a precisely-typed mock call. Matches the same untyped
// `vi.fn()` convention rate-limit.test.ts's fakeRedis uses for the same
// reason.
const { idempotencyKey } = vi.hoisted(() => ({
  idempotencyKey: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@flashsale/database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    prisma: { idempotencyKey },
  };
});

const { registerErrorHandler } = await import('./error-handler.js');
const { idempotencyGuard, registerIdempotencyPersistence } = await import('./idempotency.js');

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('idempotencyGuard + registerIdempotencyPersistence', () => {
  let app: FastifyInstance;
  let handler: ReturnType<typeof vi.fn<(request: FastifyRequest, reply: FastifyReply) => Promise<void>>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    idempotencyKey.update.mockResolvedValue(undefined);
    idempotencyKey.delete.mockResolvedValue(undefined);

    app = Fastify();
    registerErrorHandler(app);
    registerIdempotencyPersistence(app);

    handler = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(201).send(apiSuccess({ ok: true }));
    });
    app.post('/test-route', { preHandler: idempotencyGuard('POST /test-route') }, handler);

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a request with no Idempotency-Key header', async () => {
    const response = await app.inject({ method: 'POST', url: '/test-route', payload: { a: 1 } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on a fresh key, creates the IN_PROGRESS row, runs the handler, then persists the response as COMPLETED', async () => {
    idempotencyKey.create.mockResolvedValue({ id: 'idem-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/test-route',
      headers: { 'idempotency-key': 'key-1' },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    // .mock.calls[0]?.[0] + toMatchObject, not toHaveBeenCalledWith(...) --
    // nesting expect.any()/expect.objectContaining() (both typed `any` by
    // vitest) inside an object literal argument trips
    // @typescript-eslint/no-unsafe-assignment; pulling the actual call
    // argument out and matching it with toMatchObject (already used above
    // for response.json()) sidesteps that without losing precision --
    // requestHash is asserted against its exact expected value instead of
    // "any string", and toMatchObject's partial match means completedAt
    // (a real Date, not something worth pinning here) is simply ignored.
    expect(idempotencyKey.create.mock.calls[0]?.[0]).toMatchObject({
      data: { key: 'key-1', route: 'POST /test-route', requestHash: hashOf({ a: 1 }), status: 'IN_PROGRESS' },
    });
    expect(idempotencyKey.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'idem-1' },
      data: { status: 'COMPLETED', responseStatus: 201, responseBody: apiSuccess({ ok: true }) },
    });
  });

  it('replays the stored response for a repeat of the same key+body, WITHOUT re-running the handler', async () => {
    idempotencyKey.create.mockRejectedValue(uniqueConstraintError());
    idempotencyKey.findUniqueOrThrow.mockResolvedValue({
      status: 'COMPLETED',
      requestHash: hashOf({ a: 1 }),
      responseStatus: 201,
      responseBody: apiSuccess({ ok: true }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-route',
      headers: { 'idempotency-key': 'key-1' },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(apiSuccess({ ok: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects the same key reused with a DIFFERENT request body', async () => {
    idempotencyKey.create.mockRejectedValue(uniqueConstraintError());
    idempotencyKey.findUniqueOrThrow.mockResolvedValue({
      status: 'COMPLETED',
      requestHash: hashOf({ a: 999 }), // different from this request's body
      responseStatus: 201,
      responseBody: apiSuccess({ ok: true }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-route',
      headers: { 'idempotency-key': 'key-1' },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a concurrent duplicate while the original request is still IN_PROGRESS', async () => {
    idempotencyKey.create.mockRejectedValue(uniqueConstraintError());
    idempotencyKey.findUniqueOrThrow.mockResolvedValue({
      status: 'IN_PROGRESS',
      requestHash: hashOf({ a: 1 }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-route',
      headers: { 'idempotency-key': 'key-1' },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_IN_PROGRESS' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('deletes the IN_PROGRESS row on an unexpected (5xx) failure instead of caching it, so a retry can retry for real', async () => {
    idempotencyKey.create.mockResolvedValue({ id: 'idem-1' });
    handler.mockImplementation(async () => {
      throw new Error('boom: unexpected failure');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test-route',
      headers: { 'idempotency-key': 'key-1' },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(500);
    expect(idempotencyKey.delete).toHaveBeenCalledWith({ where: { id: 'idem-1' } });
    expect(idempotencyKey.update).not.toHaveBeenCalled();
  });
});

// Mirrors idempotency.ts's internal hashBody exactly (sha256 of the
// JSON-stringified body) -- duplicated here deliberately rather than
// exported from the module purely for testing, since a fixture that
// produces "some hash matching what the real body would hash to" is all
// these tests need, not access to the hashing implementation itself.
function hashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
