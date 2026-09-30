import { pushToRecentFeed, redisKeys, type Redis } from '@flashsale/redis';
import { NOTIFICATION_CONSUMER_GROUP } from '@flashsale/shared';

import { startStreamConsumerLoop, type ParsedDomainEvent, type StreamConsumerLoop } from './stream-consumer-loop.js';

import type { Logger } from '@flashsale/logger';

export type DomainEventConsumer = StreamConsumerLoop;

/**
 * The consumer half of Phase 10/11's outbox-to-stream pipeline: reads
 * stream:domain-events via a Redis consumer group and fans each event
 * out to the affected user's notification feed (packages/redis,
 * originally Phase 7's OTP feed, moved there in Phase 11 specifically so
 * this worker-side consumer and apps/api's auth flow can share it).
 *
 * Deliberately GENERIC, not "if eventType === 'reservation.created'
 * ...": every current event happens to carry `userId` in its payload,
 * and this consumer only knows "push a feed entry for whichever user
 * this event's payload names," with no per-eventType branching. A
 * future event type without a `userId` is simply skipped (logged, not
 * crashed on) rather than requiring this consumer to be updated for
 * every new aggregate Phase 13+ introduces.
 *
 * The actual read/dedup/ack loop lives in stream-consumer-loop.ts,
 * shared with Phase 16's analytics consumer -- this module supplies only
 * what's specific to notifications: the NOTIFICATION_CONSUMER_GROUP name
 * and what to do with a newly-seen event.
 */
export function startDomainEventConsumer(redis: Redis, logger: Logger): DomainEventConsumer {
  const stream = redisKeys.domainEventsStream();

  async function onNewEvent(event: ParsedDomainEvent): Promise<void> {
    const userId =
      typeof event.payload === 'object' && event.payload !== null && 'userId' in event.payload
        ? event.payload.userId
        : undefined;

    if (typeof userId === 'string') {
      await pushToRecentFeed(redis, userId, {
        id: event.outboxId,
        type: event.eventType,
        createdAt: new Date().toISOString(),
      });
    } else {
      logger.warn(
        { eventType: event.eventType, outboxId: event.outboxId },
        'domain event payload has no userId -- skipping notification fanout',
      );
    }
  }

  return startStreamConsumerLoop({ redis, logger, stream, group: NOTIFICATION_CONSUMER_GROUP, onNewEvent });
}
