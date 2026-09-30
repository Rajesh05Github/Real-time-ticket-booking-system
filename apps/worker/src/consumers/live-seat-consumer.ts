import { redisKeys, type Redis } from '@flashsale/redis';
import { LIVE_SEAT_CONSUMER_GROUP } from '@flashsale/shared';

import { startStreamConsumerLoop, type ParsedDomainEvent, type StreamConsumerLoop } from './stream-consumer-loop.js';

import type { Logger } from '@flashsale/logger';

export type LiveSeatConsumer = StreamConsumerLoop;

export type LiveSeatStatus = 'AVAILABLE' | 'RESERVED' | 'SOLD';

/** Which seat status each domain event leaves its seats in. */
const SEAT_STATUS_BY_EVENT_TYPE: Record<string, LiveSeatStatus> = {
  'reservation.created': 'RESERVED',
  'reservation.cancelled': 'AVAILABLE',
  'reservation.expired': 'AVAILABLE',
  'order.paid': 'SOLD',
  'order.refunded': 'AVAILABLE',
};

/** The wire message every open seat map receives (apps/web's
 * use-event-live hook). Shares the event's live channel with the
 * viewer-count messages, distinguished by `type`. */
export interface SeatStatusMessage {
  type: 'seatStatus';
  seats: { id: string; status: LiveSeatStatus }[];
}

export function toSeatStatusMessage(
  event: ParsedDomainEvent,
): { eventId: string; message: SeatStatusMessage } | null {
  const status = SEAT_STATUS_BY_EVENT_TYPE[event.eventType];
  if (!status) {
    return null;
  }
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const eventId = 'eventId' in payload ? payload.eventId : undefined;
  const seatIds = 'seatIds' in payload ? payload.seatIds : undefined;
  if (typeof eventId !== 'string' || !Array.isArray(seatIds) || seatIds.length === 0) {
    return null;
  }
  const ids = seatIds.filter((id): id is string => typeof id === 'string');
  return { eventId, message: { type: 'seatStatus', seats: ids.map((id) => ({ id, status })) } };
}

/**
 * The live seat-map broadcast docs/pubsub.md deferred: a third,
 * independent consumer group on stream:domain-events that turns every
 * seat-changing domain event into a PUBLISH on that event's live channel.
 * apps/api's live-broadcast plugin already fans that channel out to every
 * connected WebSocket, on every api instance -- so this consumer needs no
 * knowledge of who is connected where.
 *
 * Driven by the outbox stream rather than published directly from the
 * request path, so an update is only ever broadcast for a change that
 * actually committed. Latency is one outbox publish tick plus one
 * consumer read (a few seconds at most); a viewer who misses a message
 * (Pub/Sub has no replay) is corrected by the next full availability
 * fetch, e.g. the seat map's own refetch on a SEAT_NOT_AVAILABLE conflict.
 * Events published before this group existed (or older payloads without
 * eventId/seatIds) are skipped.
 */
export function startLiveSeatConsumer(redis: Redis, logger: Logger): LiveSeatConsumer {
  const stream = redisKeys.domainEventsStream();

  async function onNewEvent(event: ParsedDomainEvent): Promise<void> {
    const update = toSeatStatusMessage(event);
    if (!update) {
      return;
    }
    await redis.publish(redisKeys.eventLiveChannel(update.eventId), JSON.stringify(update.message));
  }

  return startStreamConsumerLoop({
    redis,
    logger,
    stream,
    group: LIVE_SEAT_CONSUMER_GROUP,
    onNewEvent,
    // A brand-new group starting from '0' would replay the whole stream
    // history as a burst of stale seat updates; live updates only make
    // sense from now on.
    startFrom: '$',
  });
}
