import { prisma, type User } from '@flashsale/database';
import { pushToRecentFeed, type Redis } from '@flashsale/redis';
import {
  ConflictError,
  DomainBadRequestError,
  JOB_NAMES,
  UnauthorizedError,
} from '@flashsale/shared';
import bcrypt from 'bcryptjs';

import { emailQueue } from '../../queues/email-queue.js';

import { createOrReclaimUnverifiedUser, findUserByEmail, markEmailVerified } from './auth.repository.js';
import { issueOtp, verifyOtp as verifyOtpCode } from './otp.js';
import { createSession, revokeSession, type SessionData } from './session.js';

export interface RequestMeta {
  // Required keys with an explicit `| undefined` value, NOT optional
  // (`?:`) keys -- under exactOptionalPropertyTypes, an optional key
  // rejects being assigned a `string | undefined`-typed expression (it
  // distinguishes "key omitted" from "key present with value undefined").
  // Callers pass `request.headers['user-agent']` directly, which IS
  // `string | undefined`, so the field type has to match that shape.
  userAgent: string | undefined;
  ipAddress: string | undefined;
}

/**
 * Shared by register and resend-otp: generates a code, records a
 * PENDING Notification row (the durable record, docs/database.md), and
 * enqueues delivery. Returns null if the resend cooldown is still active
 * -- callers turn that into a 429, this function has no HTTP knowledge.
 */
async function sendVerificationOtp(redis: Redis, user: User): Promise<boolean> {
  const issued = await issueOtp(redis, user.id);
  if (!issued) {
    return false;
  }

  const notification = await prisma.notification.create({
    data: {
      userId: user.id,
      type: 'otp_verification',
      payload: { purpose: 'email_verification' },
    },
  });

  // The Redis List "recent feed" (Phase 7, section 12) is a fast VIEW
  // over this same event, not a second source of truth -- if this call
  // fails or Redis is down, the Postgres row above is still the durable
  // record; pushToRecentFeed itself fails open rather than throwing.
  await pushToRecentFeed(redis, user.id, {
    id: notification.id,
    type: notification.type,
    createdAt: notification.createdAt.toISOString(),
  });

  await emailQueue.add(JOB_NAMES.SEND_OTP_EMAIL, {
    notificationId: notification.id,
    userId: user.id,
    email: user.email,
    otp: issued.otp,
  });

  return true;
}

export async function register(
  redis: Redis,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await createOrReclaimUnverifiedUser(email, passwordHash);

  if ('conflict' in result) {
    throw new ConflictError('An account with this email already exists.');
  }

  const sent = await sendVerificationOtp(redis, result.user);
  if (!sent) {
    // Only reachable if a client immediately re-registers the same
    // still-unverified email within the cooldown window -- rare, but
    // still a real request that needs a real (non-2xx) answer.
    throw new DomainBadRequestError(
      'OTP_COOLDOWN_ACTIVE',
      'A verification code was already sent. Please wait before requesting another.',
    );
  }

  return { userId: result.user.id };
}

export async function resendOtp(redis: Redis, email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new UnauthorizedError('If this email is registered, a code has been sent.');
  }
  if (user.emailVerifiedAt) {
    throw new DomainBadRequestError('EMAIL_ALREADY_VERIFIED', 'This email is already verified.');
  }

  const sent = await sendVerificationOtp(redis, user);
  if (!sent) {
    throw new DomainBadRequestError(
      'OTP_COOLDOWN_ACTIVE',
      'A verification code was already sent. Please wait before requesting another.',
    );
  }
}

export async function verifyOtp(redis: Redis, email: string, otp: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new DomainBadRequestError('OTP_EXPIRED', 'This code has expired or was not found.');
  }
  if (user.emailVerifiedAt) {
    // Idempotent: verifying an already-verified account succeeds silently
    // rather than erroring, since the end state the client wants
    // ("this email is verified") is already true.
    return;
  }

  const result = await verifyOtpCode(redis, user.id, otp);

  switch (result.outcome) {
    case 'valid':
      await markEmailVerified(user.id);
      return;
    case 'invalid':
      throw new DomainBadRequestError('OTP_INVALID', 'Incorrect code.', {
        attemptsRemaining: result.attemptsRemaining,
      });
    case 'locked_out':
      throw new DomainBadRequestError(
        'OTP_LOCKED',
        'Too many incorrect attempts. Request a new code.',
      );
    case 'expired_or_not_found':
      throw new DomainBadRequestError('OTP_EXPIRED', 'This code has expired or was not found.');
  }
}

export async function login(
  redis: Redis,
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<{ sessionId: string; user: User }> {
  const user = await findUserByEmail(email);
  // Same generic message whether the email doesn't exist or the password
  // is wrong -- distinguishing them lets an attacker enumerate registered
  // emails via the login endpoint.
  const invalidCredentials = new UnauthorizedError('Invalid email or password.');

  if (!user) {
    throw invalidCredentials;
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials;
  }

  if (!user.emailVerifiedAt) {
    throw new DomainBadRequestError(
      'EMAIL_NOT_VERIFIED',
      'Please verify your email before logging in.',
    );
  }

  const { sessionId } = await createSession(redis, {
    userId: user.id,
    role: user.role,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  return { sessionId, user };
}

export async function logout(redis: Redis, sessionId: string): Promise<void> {
  await revokeSession(redis, sessionId);
}

export type { SessionData };
