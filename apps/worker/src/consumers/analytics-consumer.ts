import { redisKeys, type Redis } from '@flashsale/redis';
import { ANALYTICS_CONSUMER_GROUP } from '@flashsale/shared';

import { startStreamConsumerLoop, type ParsedDomainEvent, type StreamConsumerLoop } from './stream-consumer-loop.js';

import type { Logger } from '@flashsale/logger';

export type AnalyticsConsumer = StreamConsumerLoop;

/**
 * Phase 16: the second, fully independent consumer group on
 * stream:domain-events -- exactly the scenario docs/streams.md flagged
 * Phase 11 as deliberately deferring ("nothing stops a future phase from
 * adding an independent one... reading the same stream at its own
 * pace"). This group has its own cursor and Pending Entries List and its
 * own dedup ledger (ProcessedEvent keyed on (ANALYTICS_CONSUMER_GROUP,
 * outboxId)); a crash or backlog here has zero effect on
 * `notifications`'s delivery, and vice versa.
 *
 * Deliberately generic like the notification consumer: EVERY event type
 * increments its own lifetime counter (redisKeys.analyticsEventCounts,
 * a Hash -- HINCRBY), with no per-type branching for that part. Revenue
 * is the one place this consumer does branch, because "realized
 * revenue" is a meaningful concept only for one specific event type
 * ('order.paid') -- an 'order.created' event exists before payment even
 * succeeds, so counting revenue there would count orders whose payment
 * goes on to fail.
 */
export function startAnalyticsConsumer(redis: Redis, logger: Logger): AnalyticsConsumer {
  const stream = redisKeys.domainEventsStream();

  async function onNewEvent(event: ParsedDomainEvent): Promise<void> {
    await redis.hincrby(redisKeys.analyticsEventCounts(), event.eventType, 1);

    // order.paid adds realized revenue; order.refunded (a cancelled paid
    // booking) takes the same order total back out, so the dashboard
    // reports net revenue rather than gross-ever-charged.
    if (event.eventType !== 'order.paid' && event.eventType !== 'order.refunded') {
      return;
    }

    const payload = event.payload;
    const amountMinor = typeof payload === 'object' && payload !== null && 'amountMinor' in payload
      ? payload.amountMinor
      : undefined;
    const currency = typeof payload === 'object' && payload !== null && 'currency' in payload
      ? payload.currency
      : undefined;

    if (typeof amountMinor === 'string' && typeof currency === 'string') {
      // Passed as the string ioredis received it, not `Number(...)` --
      // amountMinor is serialized as a string specifically because it
      // came from a bigint (see order.repository.ts), and HINCRBY parses
      // its increment argument as a 64-bit integer either way, so
      // routing it through a JS `number` first would only risk precision
      // loss for no benefit.
      const increment = event.eventType === 'order.refunded' ? `-${amountMinor}` : amountMinor;
      await redis.hincrby(redisKeys.analyticsRevenueByCurrency(), currency, increment);
    } else {
      logger.warn(
        { outboxId: event.outboxId, eventType: event.eventType },
        'order event missing amountMinor/currency -- skipping revenue rollup',
      );
    }
  }

  return startStreamConsumerLoop({ redis, logger, stream, group: ANALYTICS_CONSUMER_GROUP, onNewEvent });
}
