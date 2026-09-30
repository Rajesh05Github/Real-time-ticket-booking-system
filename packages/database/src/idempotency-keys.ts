import { prisma } from './client.js';

export interface IdempotencyKeyCleanupResult {
  completedDeleted: number;
  staleInProgressDeleted: number;
}

/**
 * Retention for idempotency_keys (apps/api's idempotency plugin writes one
 * row per guarded request and, until this existed, never deleted any).
 * Served by `@@index([status, createdAt])`.
 *
 *  - COMPLETED rows older than `completedOlderThan` are past any
 *    realistic client retry window and only cost storage.
 *  - IN_PROGRESS rows older than `inProgressOlderThan` belong to a
 *    request whose process died mid-flight; left alone they would answer
 *    every retry of that key with REQUEST_IN_PROGRESS forever.
 */
export async function deleteExpiredIdempotencyKeys(
  completedOlderThan: Date,
  inProgressOlderThan: Date,
): Promise<IdempotencyKeyCleanupResult> {
  const completed = await prisma.idempotencyKey.deleteMany({
    where: { status: 'COMPLETED', createdAt: { lt: completedOlderThan } },
  });
  const staleInProgress = await prisma.idempotencyKey.deleteMany({
    where: { status: 'IN_PROGRESS', createdAt: { lt: inProgressOlderThan } },
  });
  return { completedDeleted: completed.count, staleInProgressDeleted: staleInProgress.count };
}
