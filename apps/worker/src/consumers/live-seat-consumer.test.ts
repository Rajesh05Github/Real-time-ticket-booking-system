import { describe, expect, it } from 'vitest';

import { toSeatStatusMessage } from './live-seat-consumer.js';

import type { ParsedDomainEvent } from './stream-consumer-loop.js';

function event(eventType: string, payload: unknown): ParsedDomainEvent {
  return { outboxId: 'outbox-1', aggregateType: 'x', aggregateId: 'y', eventType, payload };
}

describe('toSeatStatusMessage', () => {
  it.each([
    ['reservation.created', 'RESERVED'],
    ['reservation.cancelled', 'AVAILABLE'],
    ['reservation.expired', 'AVAILABLE'],
    ['order.paid', 'SOLD'],
    ['order.refunded', 'AVAILABLE'],
  ])('maps %s to seat status %s on the event live channel', (eventType, status) => {
    const result = toSeatStatusMessage(event(eventType, { eventId: 'event-1', seatIds: ['s1', 's2'] }));
    expect(result).toEqual({
      eventId: 'event-1',
      message: {
        type: 'seatStatus',
        seats: [
          { id: 's1', status },
          { id: 's2', status },
        ],
      },
    });
  });

  it('ignores event types that do not change seat state', () => {
    expect(toSeatStatusMessage(event('order.created', { eventId: 'event-1', seatIds: ['s1'] }))).toBeNull();
    expect(toSeatStatusMessage(event('payment.failed', { eventId: 'event-1', seatIds: ['s1'] }))).toBeNull();
  });

  it('skips older payloads that carry no eventId or seatIds', () => {
    expect(toSeatStatusMessage(event('reservation.cancelled', { reservationId: 'r1', seatIds: ['s1'] }))).toBeNull();
    expect(toSeatStatusMessage(event('order.paid', { eventId: 'event-1' }))).toBeNull();
    expect(toSeatStatusMessage(event('order.paid', { eventId: 'event-1', seatIds: [] }))).toBeNull();
    expect(toSeatStatusMessage(event('order.paid', undefined))).toBeNull();
  });
});
