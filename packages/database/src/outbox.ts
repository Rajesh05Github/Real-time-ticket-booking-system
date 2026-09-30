import { prisma } from './client.js';

import type { Prisma, OutboxEvent } from '@prisma/client';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Writes one outbox row (schema.prisma's OutboxEvent, Phase 3) as part of
 * an ALREADY-OPEN transaction -- callers pass the same `tx` they used for
 * the business write this event describes (reservation.repository.ts's
 * `createReservationWithItems`, this package's own `releaseReservation`),
 * never a fresh `prisma` call. That's the entire mechanism: if the
 * transaction commits, the business row and this outbox row both exist;
 * if it rolls back, neither does. There is no window where one exists
 * without the other, which is what a dual-write (write the business row,
 * then separately publish an event) can never guarantee -- a crash
 * between the two halves of a dual-write either loses the event or
 * publishes one for a change that got rolled back. Section 8.
 */
export function writeOutboxEvent(tx: Prisma.TransactionClient, event: OutboxEventInput): Promise<OutboxEvent> {
  return tx.outboxEvent.create({ data: event });
}

/**
 * The publisher's exact query (apps/worker/src/jobs/outbox-publisher.ts)
 * -- matches schema.prisma's `@@index([status, createdAt])` on
 * OutboxEvent directly. Oldest-first, not unordered: two events for the
 * same aggregate (e.g. a reservation created then immediately cancelled)
 * should reach the stream in the order they actually happened.
 */
export function findPendingOutboxEvents(limit: number): Promise<OutboxEvent[]> {
  return prisma.outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export function markOutboxEventPublished(id: string): Promise<OutboxEvent> {
  return prisma.outboxEvent.update({
    where: { id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
}

/**
 * Called when XADD itself fails (a Redis outage, not a business error --
 * there's no such thing as a "rejected" domain event). Leaves the row
 * PENDING (so the next publish tick retries it) unless this was already
 * its `maxAttempts`th failure, in which case it's marked FAILED --
 * stopping an unpublishable event from being retried forever and masking
 * a real, ongoing problem. FAILED is a dead letter an operator has to
 * look at, not a self-healing state; nothing in this codebase currently
 * un-fails one automatically, which is intentional (see docs/outbox.md).
 */
export async function recordOutboxPublishFailure(id: string, maxAttempts: number): Promise<void> {
  const event = await prisma.outboxEvent.update({
    where: { id },
    data: { attempts: { increment: 1 } },
  });

  if (event.attempts >= maxAttempts) {
    await prisma.outboxEvent.update({ where: { id }, data: { status: 'FAILED' } });
  }
}
