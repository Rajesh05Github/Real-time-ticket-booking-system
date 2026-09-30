import { DOMAIN_EVENTS_STREAM_MAXLEN, OUTBOX_PUBLISH_INTERVAL_MS } from '@flashsale/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@flashsale/database', () => ({
  findPendingOutboxEvents: vi.fn(),
  markOutboxEventPublished: vi.fn(),
  recordOutboxPublishFailure: vi.fn(),
}));

const { findPendingOutboxEvents, markOutboxEventPublished, recordOutboxPublishFailure } =
  await import('@flashsale/database');
const { startOutboxPublisher } = await import('./outbox-publisher.js');

import type { Logger } from '@flashsale/logger';
import type { Redis } from '@flashsale/redis';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const sampleEvent = {
  id: 'outbox-1',
  aggregateType: 'reservation',
  aggregateId: 'res-1',
  eventType: 'reservation.created',
  payload: { reservationId: 'res-1' },
  status: 'PENDING' as const,
  attempts: 0,
  createdAt: new Date(),
  publishedAt: null,
};

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return { xadd: vi.fn().mockResolvedValue('1-0'), ...overrides } as unknown as Redis;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startOutboxPublisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Real recordOutboxPublishFailure always returns a Promise; give the
    // mock the same default so publishOnce's `.catch(...)` on its result
    // doesn't throw a TypeError on `undefined.catch` in tests that don't
    // care about this call specifically.
    vi.mocked(recordOutboxPublishFailure).mockResolvedValue(undefined);
  });

  it('XADDs each pending event with MAXLEN ~ trimming and the expected fields, then marks it PUBLISHED', async () => {
    vi.mocked(findPendingOutboxEvents).mockResolvedValueOnce([sampleEvent]).mockResolvedValue([]);
    const redis = fakeRedis();

    const publisher = startOutboxPublisher(redis, silentLogger);
    await vi.waitFor(() => expect(markOutboxEventPublished).toHaveBeenCalled(), { timeout: 2000 });
    await publisher.stop();

    expect(redis.xadd).toHaveBeenCalledWith(
      'stream:domain-events',
      'MAXLEN',
      '~',
      DOMAIN_EVENTS_STREAM_MAXLEN,
      '*',
      'outboxId',
      'outbox-1',
      'aggregateType',
      'reservation',
      'aggregateId',
      'res-1',
      'eventType',
      'reservation.created',
      'payload',
      JSON.stringify(sampleEvent.payload),
    );
    expect(markOutboxEventPublished).toHaveBeenCalledWith('outbox-1');
  });

  it('records a publish failure (not markOutboxEventPublished) when XADD rejects, and continues the batch', async () => {
    vi.mocked(findPendingOutboxEvents)
      .mockResolvedValueOnce([
        { ...sampleEvent, id: 'outbox-bad' },
        { ...sampleEvent, id: 'outbox-good' },
      ])
      .mockResolvedValue([]);
    const redis = fakeRedis({
      xadd: vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce('1-0'),
    });

    const publisher = startOutboxPublisher(redis, silentLogger);
    await vi.waitFor(() => expect(markOutboxEventPublished).toHaveBeenCalledWith('outbox-good'), {
      timeout: 2000,
    });
    await publisher.stop();

    expect(recordOutboxPublishFailure).toHaveBeenCalledWith('outbox-bad', expect.any(Number));
    expect(markOutboxEventPublished).not.toHaveBeenCalledWith('outbox-bad');
  });

  it(
    "stop() awaits an IN-FLIGHT tick rather than just clearing the timer -- same shutdown-safety " +
      'contract as the reservation expiry sweeper',
    async () => {
      let xaddResolve!: (value: string) => void;
      vi.mocked(findPendingOutboxEvents).mockResolvedValue([sampleEvent]);
      const redis = fakeRedis({
        xadd: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              xaddResolve = resolve;
            }),
        ),
      });

      const publisher = startOutboxPublisher(redis, silentLogger);
      await vi.waitFor(() => expect(redis.xadd).toHaveBeenCalled(), { timeout: 2000 });

      let stopResolved = false;
      const stopPromise = publisher.stop().then(() => {
        stopResolved = true;
      });

      await delay(20);
      expect(stopResolved).toBe(false);

      xaddResolve('1-0');
      await stopPromise;
      expect(stopResolved).toBe(true);
    },
    3000,
  );

  it('skips a tick that would overlap a still-running one', async () => {
    vi.useFakeTimers();
    try {
      let xaddResolve!: (value: string) => void;
      vi.mocked(findPendingOutboxEvents).mockResolvedValue([sampleEvent]);
      const redis = fakeRedis({
        xadd: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              xaddResolve = resolve;
            }),
        ),
      });

      const publisher = startOutboxPublisher(redis, silentLogger);
      await vi.advanceTimersByTimeAsync(0);
      expect(findPendingOutboxEvents).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(OUTBOX_PUBLISH_INTERVAL_MS * 2);
      expect(findPendingOutboxEvents).toHaveBeenCalledTimes(1);

      xaddResolve('1-0');
      await publisher.stop();

      expect(findPendingOutboxEvents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
