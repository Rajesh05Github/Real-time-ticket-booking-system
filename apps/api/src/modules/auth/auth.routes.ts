import {
  apiSuccess,
  RATE_LIMIT_LOGIN,
  RATE_LIMIT_REGISTER,
  RATE_LIMIT_RESEND_OTP,
  RATE_LIMIT_VERIFY_OTP,
  SESSION_COOKIE_NAME,
  UnauthorizedError,
} from '@flashsale/shared';

import { env } from '../../env.js';
import { getSessionOrThrow, requireAuth } from '../../plugins/auth-hook.js';
import { clearCsrfCookie, setCsrfCookie } from '../../plugins/csrf.js';
import { rateLimit } from '../../plugins/rate-limit.js';

import { findUserById } from './auth.repository.js';
import { loginSchema, registerSchema, resendOtpSchema, verifyOtpSchema } from './auth.schema.js';
import * as authService from './auth.service.js';

import type { FastifyInstance } from 'fastify';

/**
 * Section 32's versioned API surface starts here: everything in this
 * module is registered under /api/v1/auth (see app.ts's prefix), plus
 * /api/v1/me for the authenticated-principal lookup.
 *
 * Not `async` -- route registration itself (app.post/app.get calls) is
 * synchronous; each individual handler is its own async function that
 * awaits what it needs.
 */
export function authRoutes(app: FastifyInstance): void {
  app.post('/register', { preHandler: rateLimit(RATE_LIMIT_REGISTER) }, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const result = await authService.register(app.redis, body.email, body.password);
    reply.status(201).send(apiSuccess(result));
  });

  app.post('/resend-otp', { preHandler: rateLimit(RATE_LIMIT_RESEND_OTP) }, async (request, reply) => {
    const body = resendOtpSchema.parse(request.body);
    await authService.resendOtp(app.redis, body.email);
    reply.status(200).send(apiSuccess({ sent: true }));
  });

  app.post('/verify-otp', { preHandler: rateLimit(RATE_LIMIT_VERIFY_OTP) }, async (request, reply) => {
    const body = verifyOtpSchema.parse(request.body);
    await authService.verifyOtp(app.redis, body.email, body.otp);
    reply.status(200).send(apiSuccess({ verified: true }));
  });

  app.post('/login', { preHandler: rateLimit(RATE_LIMIT_LOGIN) }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const { sessionId, user } = await authService.login(app.redis, body.email, body.password, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    // HttpOnly + Secure (in production) + SameSite=Lax + signed: section
    // 21's "never localStorage.setItem('token', ...)" requirement made
    // concrete. `secure` is gated on NODE_ENV because a Secure cookie is
    // silently dropped by browsers over plain HTTP -- forcing it on
    // unconditionally would break local development entirely, not just
    // warn about it.
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      signed: true,
    });
    // Phase 20: the CSRF double-submit cookie, issued alongside the
    // session cookie -- see plugins/csrf.ts for why it's a separate,
    // non-HttpOnly cookie rather than folded into the one above.
    setCsrfCookie(reply, sessionId);

    reply.status(200).send(
      apiSuccess({
        user: { id: user.id, email: user.email, role: user.role },
      }),
    );
  });

  app.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    await authService.logout(app.redis, session.sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    clearCsrfCookie(reply);
    reply.status(200).send(apiSuccess({ loggedOut: true }));
  });
}

export function meRoutes(app: FastifyInstance): void {
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const session = getSessionOrThrow(request);
    const user = await findUserById(session.userId);
    if (!user) {
      // The session referenced a user id that no longer exists in
      // Postgres -- Redis and Postgres have drifted (e.g. a manual DB
      // edit in development). Treat it the same as no session at all
      // rather than exposing an internal inconsistency to the client,
      // and route it through the SAME error envelope every other 401
      // uses instead of a bespoke shape.
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      clearCsrfCookie(reply);
      throw new UnauthorizedError('Session expired or not found.');
    }

    reply.status(200).send(
      apiSuccess({
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerifiedAt: user.emailVerifiedAt,
      }),
    );
  });
}
