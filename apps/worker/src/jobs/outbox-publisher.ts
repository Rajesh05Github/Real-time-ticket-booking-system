import {
  findPendingOutboxEvents,
  markOutboxEventPublished,
  recordOutboxPublishFailure,
} from '@flashsale/database';
import { redisKeys, type Redis } from '@flashsale/redis';
import {
  DOMAIN_EVENTS_STREAM_MAXLEN,
  OUTBOX_MAX_PUBLISH_ATTEMPTS,
  OUTBOX_PUBLISH_BATCH_SIZE,
  OUTBOX_PUBLISH_INTERVAL_MS,
} from '@flashsale/shared';

import type { Logger } from '@flashsale/logger';

export interface OutboxPublisher {
  /** Async, awaits any in-flight tick -- same shutdown-safety contract
   * as reservation-expiry-sweep.ts's sweeper; see its comment for why. */
  stop: () => Promise<void>;
}

/**
 * The publisher half of Phase 10's transactional outbox (section 8):
 * every OUTBOX_PUBLISH_INTERVAL_MS (plus once immediately on startup),
 * take up to OUTBOX_PUBLISH_BATCH_SIZE PENDING rows, XADD each to
 * stream:domain-events, and mark it PUBLISHED. Structurally this is the
 * same "plain setInterval, immediate first tick, overlap protection,
 * awaitable stop()" shape as reservation-expiry-sweep.ts -- the same
 * reasoning applies (no per-item retry/backoff semantics distinct
 * enough from "try again next tick" to justify a queue).
 *
 * At-least-once, not exactly-once: if XADD succeeds but this process
 * crashes (or Postgres blips) before markOutboxEventPublished commits,
 * the row is still PENDING and gets published AGAIN on a later tick --
 * a duplicate stream entry. This is a deliberate, well-known property of
 * the outbox pattern, not a bug to eliminate here: Phase 11's consumer
 * groups are expected to dedupe via ProcessedEvent, keyed on the
 * `outboxId` field carried in every stream entry (stable across a
 * republish, unlike the Redis-generated stream ID, which differs each
 * time the SAME outbox row is re-added).
 */
export function startOutboxPublisher(redis: Redis, logger: Logger): OutboxPublisher {
  let currentTick: Promise<void> | null = null;
  let stopped = false;

  async function publishOnce(event: Awaited<ReturnType<typeof findPendingOutboxEvents>>[number]): Promise<boolean> {
    try {
      await redis.xadd(
        redisKeys.domainEventsStream(),
        'MAXLEN',
        '~',
        DOMAIN_EVENTS_STREAM_MAXLEN,
        '*',
        'outboxId',
        event.id,
        'aggregateType',
        event.aggregateType,
        'aggregateId',
        event.aggregateId,
        'eventType',
        event.eventType,
        'payload',
        JSON.stringify(event.payload),
      );
      await markOutboxEventPublished(event.id);
      return true;
    } catch (err) {
      logger.error({ err, outboxId: event.id, eventType: event.eventType }, 'failed to publish outbox event');
      await recordOutboxPublishFailure(event.id, OUTBOX_MAX_PUBLISH_ATTEMPTS).catch((cleanupErr: unknown) => {
        logger.error({ err: cleanupErr, outboxId: event.id }, 'failed to record outbox publish failure');
      });
      return false;
    }
  }

  async function runPublish(): Promise<void> {
    try {
      const pending = await findPendingOutboxEvents(OUTBOX_PUBLISH_BATCH_SIZE);
      let publishedCount = 0;

      for (const event of pending) {
        if (await publishOnce(event)) {
          publishedCount += 1;
        }
      }

      if (publishedCount > 0) {
        logger.info({ publishedCount, scanned: pending.length }, 'outbox publish tick completed');
      }
      if (pending.length === OUTBOX_PUBLISH_BATCH_SIZE) {
        logger.warn(
          { batchSize: OUTBOX_PUBLISH_BATCH_SIZE },
          'outbox publish tick hit its batch size limit -- there may be a backlog, will continue on the next tick',
        );
      }
    } catch (err) {
      logger.error({ err }, 'outbox publish tick failed');
    }
  }

  function fireTick(): void {
    if (currentTick || stopped) {
      return;
    }
    currentTick = runPublish().finally(() => {
      currentTick = null;
    });
  }

  fireTick();
  const interval = setInterval(fireTick, OUTBOX_PUBLISH_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await currentTick;
    },
  };
}
