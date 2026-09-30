import { Prisma } from '@prisma/client';

import { prisma } from './client.js';

/**
 * Idempotent-consumption guard for ANY Redis Streams consumer group
 * (schema.prisma's ProcessedEvent, Phase 3, first used in Phase 11).
 * Scoped by (consumerGroup, eventId) so two different consumer groups
 * reading the SAME stream each get their own independent "have I seen
 * this one" bookkeeping -- one group being ahead or behind another
 * doesn't affect either's correctness.
 *
 * The same insert-as-lock idiom this codebase already uses twice
 * elsewhere (idempotency_keys in Phase 9, the reservation_items partial
 * unique index in Phase 3): the `@@unique([consumerGroup, eventId])`
 * constraint IS the check -- there is no separate "does this exist"
 * query that could race against a concurrent consumer (relevant once
 * more than one consumer instance reads from the same group, which
 * XREADGROUP's whole design assumes will eventually happen).
 *
 * `eventId` should be the outbox row's OWN id (carried as the
 * `outboxId` field on every stream entry -- docs/outbox.md), not the
 * Redis-generated stream ID: the same outbox row can appear as multiple
 * DIFFERENT stream IDs if the publisher's at-least-once delivery
 * re-adds it after a crash, and it's the LOGICAL event this function
 * needs to dedupe, not each individual delivery attempt.
 */
export async function tryMarkEventProcessed(consumerGroup: string, eventId: string): Promise<boolean> {
  try {
    await prisma.processedEvent.create({ data: { consumerGroup, eventId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return false;
    }
    throw err;
  }
}
