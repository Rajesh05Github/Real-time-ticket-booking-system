import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@flashsale/logger';
import type * as RedisModule from '@flashsale/redis';

vi.mock('@flashsale/database', () => ({
  tryMarkEventProcessed: vi.fn(),
}));

vi.mock('@flashsale/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisModule>();
  return {
    ...actual,
    pushToRecentFeed: vi.fn().mockResolvedValue(undefined),
  };
});

const { tryMarkEventProcessed } = await import('@flashsale/database');
const { pushToRecentFeed } = await import('@flashsale/redis');
const { startDomainEventConsumer } = await import('./domain-event-consumer.js');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A real BLOCKing XREADGROUP against real Redis always takes SOME time
// (up to STREAM_CONSUMER_BLOCK_MS) even when nothing new has arrived --
// that's what naturally throttles the consumer's while(!stopped) loop in
// production. An instantly-resolving mock has no such throttle: without
// this delay, a test whose xreadgroup/xautoclaim just returns immediately
// spins the loop as fast as the event loop allows for the entire time
// between starting the consumer and calling stop() (including the time
// vi.waitFor spends polling), generating enough garbage to OOM the test
// worker -- which is exactly what happened before this fixture existed.
function delayedNull<T>(value: T): () => Promise<T> {
  return () => delay(5).then(() => value);
}

function fakeRedis(overrides: Partial<RedisModule.Redis> = {}): RedisModule.Redis {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xautoclaim: vi.fn().mockImplementation(delayedNull(['0-0', []])),
    xreadgroup: vi.fn().mockImplementation(delayedNull(null)),
    xack: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as RedisModule.Redis;
}

describe('startDomainEventConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the consumer group starting at "0" (catch up on backlog), tolerating BUSYGROUP', async () => {
    const redis = fakeRedis();
    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xgroup).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.xgroup).toHaveBeenCalledWith('CREATE', 'stream:domain-events', 'notifications', '0', 'MKSTREAM');
  });

  it('does not throw when the group already exists (BUSYGROUP)', async () => {
    const redis = fakeRedis({
      xgroup: vi.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
    });
    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xreadgroup).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();
  });

  it('processes a new event: marks it processed, pushes to the feed, then ACKs', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      [
        'outboxId', 'outbox-1',
        'aggregateType', 'reservation',
        'aggregateId', 'res-1',
        'eventType', 'reservation.created',
        'payload', JSON.stringify({ userId: 'user-1', reservationId: 'res-1' }),
      ],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(tryMarkEventProcessed).toHaveBeenCalledWith('notifications', 'outbox-1');
    expect(pushToRecentFeed).toHaveBeenCalledWith(
      redis,
      'user-1',
      expect.objectContaining({ id: 'outbox-1', type: 'reservation.created' }),
    );
    expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'notifications', '1-0');
  });

  it('skips reprocessing (no pushToRecentFeed) but still ACKs a message already marked processed', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(false);
    const message: [string, string[]] = [
      '1-0',
      ['outboxId', 'outbox-1', 'aggregateType', 'reservation', 'aggregateId', 'res-1', 'eventType', 'reservation.created', 'payload', '{}'],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(pushToRecentFeed).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'notifications', '1-0');
  });

  it('logs a warning and skips fanout (but still ACKs) when the payload has no userId', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      ['outboxId', 'outbox-1', 'aggregateType', 'reservation', 'aggregateId', 'res-1', 'eventType', 'some.event', 'payload', '{}'],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(pushToRecentFeed).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: 'outbox-1' }),
      'domain event payload has no userId -- skipping notification fanout',
    );
    expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'notifications', '1-0');
  });

  it('reclaims and processes stale pending messages via XAUTOCLAIM', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const claimed: [string, string[]] = [
      '0-1',
      ['outboxId', 'outbox-stale', 'aggregateType', 'reservation', 'aggregateId', 'res-2', 'eventType', 'reservation.cancelled', 'payload', JSON.stringify({ userId: 'user-2' })],
    ];
    const redis = fakeRedis({
      xautoclaim: vi
        .fn()
        .mockResolvedValueOnce(['0-0', [claimed]])
        .mockImplementation(delayedNull(['0-0', []])),
    });

    const consumer = startDomainEventConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'notifications', '0-1'), {
      timeout: 2000,
    });
    await consumer.stop();

    expect(pushToRecentFeed).toHaveBeenCalledWith(redis, 'user-2', expect.objectContaining({ id: 'outbox-stale' }));
  });

  it(
    "stop() awaits the blocking XREADGROUP call rather than resolving immediately -- the same shutdown-safety " +
      'contract as the sweeper and publisher, adapted for a continuous read loop instead of a periodic tick',
    async () => {
      let xreadResolve!: (value: null) => void;
      const redis = fakeRedis({
        xreadgroup: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              xreadResolve = resolve;
            }),
        ),
      });

      const consumer = startDomainEventConsumer(redis, silentLogger);
      await vi.waitFor(() => expect(redis.xreadgroup).toHaveBeenCalled(), { timeout: 2000 });

      let stopResolved = false;
      const stopPromise = consumer.stop().then(() => {
        stopResolved = true;
      });

      await delay(20);
      expect(stopResolved).toBe(false);

      xreadResolve(null);
      await stopPromise;
      expect(stopResolved).toBe(true);
    },
    3000,
  );
});
