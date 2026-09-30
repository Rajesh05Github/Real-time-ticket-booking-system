import { randomUUID } from 'node:crypto';

import { prisma } from '@flashsale/database';
import { redisKeys } from '@flashsale/redis';
import { SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS, SESSION_TTL_SECONDS } from '@flashsale/shared';

import type { UserRole } from '@flashsale/database';
import type { Redis } from '@flashsale/redis';

export interface SessionData {
  userId: string;
  role: UserRole;
  createdAt: number;
  lastActivityAt: number;
}

export interface CreateSessionInput {
  userId: string;
  role: UserRole;
  // Required keys with an explicit `| undefined` value -- see
  // auth.service.ts's RequestMeta for why this shape, not `?:`, is what
  // exactOptionalPropertyTypes needs from a caller passing
  // request.headers['user-agent'] directly.
  userAgent: string | undefined;
  ipAddress: string | undefined;
}

/**
 * Writes BOTH the Redis fast-path hash and the Postgres audit row in one
 * call, using the SAME generated id for both (docs/database.md's
 * `Session.id` has no database default specifically so this is possible)
 * -- there is deliberately no code path where these two records could
 * disagree about a session's identity.
 */
export async function createSession(
  redis: Redis,
  input: CreateSessionInput,
): Promise<{ sessionId: string }> {
  const sessionId = randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);

  const data: SessionData = {
    userId: input.userId,
    role: input.role,
    createdAt: now,
    lastActivityAt: now,
  };

  await redis
    .multi()
    .hset(redisKeys.session(sessionId), {
      userId: data.userId,
      role: data.role,
      createdAt: String(data.createdAt),
      lastActivityAt: String(data.lastActivityAt),
    })
    .expire(redisKeys.session(sessionId), SESSION_TTL_SECONDS)
    .exec();

  // Written once at creation, not on every request -- see
  // docs/auth-flow.md for the write-volume reasoning behind keeping this
  // row separate from the Redis hash above.
  //
  // userAgent/ipAddress are spread in conditionally, not assigned
  // directly: Prisma's generated input type marks them optional (`field?:
  // string | null`), and exactOptionalPropertyTypes treats "key present
  // with value undefined" as a DIFFERENT, disallowed shape from "key
  // omitted" -- so a request with no User-Agent header must omit the key
  // entirely rather than pass `userAgent: undefined`.
  await prisma.session.create({
    data: {
      id: sessionId,
      userId: input.userId,
      expiresAt,
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
    },
  });

  return { sessionId };
}

export async function getSession(redis: Redis, sessionId: string): Promise<SessionData | null> {
  const record = await redis.hgetall(redisKeys.session(sessionId));
  if (!record.userId) {
    return null;
  }

  return {
    userId: record.userId,
    role: record.role as UserRole,
    createdAt: Number(record.createdAt),
    lastActivityAt: Number(record.lastActivityAt),
  };
}

/**
 * Only writes `lastActivityAt` back to Redis if the existing value is
 * stale by more than SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS (Phase 0
 * correction #16). Without this throttle, an authenticated user's every
 * single request would cost a Redis write purely to update a timestamp
 * nothing reads at sub-minute granularity -- doubling this app's Redis
 * write volume for observability nobody needs that precise.
 */
export async function touchSessionIfStale(
  redis: Redis,
  sessionId: string,
  session: SessionData,
): Promise<void> {
  const staleMs = SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS * 1000;
  if (Date.now() - session.lastActivityAt < staleMs) {
    return;
  }

  await redis.hset(redisKeys.session(sessionId), 'lastActivityAt', String(Date.now()));
}

/**
 * Revokes a session in both stores. The Redis DEL is what actually ends
 * the session immediately (the fast-path lookup future requests hit); the
 * Postgres update is the audit trail recording that it was deliberately
 * revoked (vs. left to expire naturally) and when.
 */
export async function revokeSession(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(redisKeys.session(sessionId));
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}
