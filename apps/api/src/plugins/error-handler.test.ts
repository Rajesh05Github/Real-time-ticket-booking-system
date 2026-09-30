import { AppError, apiFailure } from '@flashsale/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerErrorHandler } from './error-handler.js';

class TestForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'TEST_FORBIDDEN';

  constructor() {
    super('nope');
  }
}

describe('registerErrorHandler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerErrorHandler(app);
    app.post('/echo', async (request) => ({ received: request.body }));
    app.get('/boom-app-error', async () => {
      throw new TestForbiddenError();
    });
    app.get('/boom-unknown', async () => {
      throw new Error('something genuinely broke');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Regression test for a real bug found live by Phase 18's load-testing
   * setup script: sending `Content-Type: application/json` with an empty
   * body makes FASTIFY ITSELF throw `FST_ERR_CTP_EMPTY_JSON_BODY`, which
   * carries its own `statusCode: 400` -- before this fix, the error
   * handler's fallthrough treated every non-AppError/ZodError/
   * schema-validation error as an unhandled 500, silently discarding that
   * statusCode and turning an ordinary malformed-request client mistake
   * into a misleading "Internal Server Error."
   */
  it('maps a Fastify built-in parsing error (empty JSON body) to ITS OWN statusCode, not a 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'FST_ERR_CTP_EMPTY_JSON_BODY' } });
  });

  it('still lets a real AppError through with its own status/code (unaffected by the new branch)', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom-app-error' });
    expect(response.statusCode).toBe(403);
    const body = response.json<{ requestId: string }>();
    expect(body).toEqual(apiFailure('TEST_FORBIDDEN', 'nope', undefined, body.requestId));
  });

  it('still maps a genuinely unknown error to a generic 500 (never leaks the real message)', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom-unknown' });
    expect(response.statusCode).toBe(500);
    const body = response.json<{ success: boolean; error: { message: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.message).not.toContain('something genuinely broke');
  });
});
