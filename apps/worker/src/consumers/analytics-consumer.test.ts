import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@flashsale/logger';
import type * as RedisModule from '@flashsale/redis';

vi.mock('@flashsale/database', () => ({
  tryMarkEventProcessed: vi.fn(),
}));

const { tryMarkEventProcessed } = await import('@flashsale/database');
const { startAnalyticsConsumer } = await import('./analytics-consumer.js');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See domain-event-consumer.test.ts's identical fixture for why this
// delay exists: an instantly-resolving mock XREADGROUP/XAUTOCLAIM spins
// the while(!stopped) loop as fast as the event loop allows, generating
// enough garbage to OOM the test worker.
function delayedNull<T>(value: T): () => Promise<T> {
  return () => delay(5).then(() => value);
}

function fakeRedis(overrides: Partial<RedisModule.Redis> = {}): RedisModule.Redis {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xautoclaim: vi.fn().mockImplementation(delayedNull(['0-0', []])),
    xreadgroup: vi.fn().mockImplementation(delayedNull(null)),
    xack: vi.fn().mockResolvedValue(1),
    hincrby: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as RedisModule.Redis;
}

describe('startAnalyticsConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates its OWN consumer group ("analytics"), independent of the notifications group', async () => {
    const redis = fakeRedis();
    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xgroup).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.xgroup).toHaveBeenCalledWith('CREATE', 'stream:domain-events', 'analytics', '0', 'MKSTREAM');
  });

  it('increments the lifetime event-count hash for ANY event type, with no per-type branching', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      [
        'outboxId', 'outbox-1',
        'aggregateType', 'reservation',
        'aggregateId', 'res-1',
        'eventType', 'reservation.created',
        'payload', JSON.stringify({ userId: 'user-1' }),
      ],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(tryMarkEventProcessed).toHaveBeenCalledWith('analytics', 'outbox-1');
    expect(redis.hincrby).toHaveBeenCalledWith('analytics:eventCounts', 'reservation.created', 1);
    expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'analytics', '1-0');
  });

  it('additionally rolls up revenue for order.paid using the payload amountMinor/currency', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      [
        'outboxId', 'outbox-2',
        'aggregateType', 'order',
        'aggregateId', 'order-1',
        'eventType', 'order.paid',
        'payload', JSON.stringify({ orderId: 'order-1', amountMinor: '150000', currency: 'INR' }),
      ],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.hincrby).toHaveBeenCalledWith('analytics:eventCounts', 'order.paid', 1);
    expect(redis.hincrby).toHaveBeenCalledWith('analytics:revenueMinorByCurrency', 'INR', '150000');
  });

  it('does NOT touch the revenue hash for a non-order.paid event', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      ['outboxId', 'outbox-3', 'aggregateType', 'order', 'aggregateId', 'order-2', 'eventType', 'order.created', 'payload', '{}'],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.hincrby).toHaveBeenCalledTimes(1);
    expect(redis.hincrby).toHaveBeenCalledWith('analytics:eventCounts', 'order.created', 1);
  });

  it('logs a warning and skips the revenue rollup (but still counts the event) when order.paid is missing amountMinor/currency', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      ['outboxId', 'outbox-4', 'aggregateType', 'order', 'aggregateId', 'order-3', 'eventType', 'order.paid', 'payload', '{}'],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.hincrby).toHaveBeenCalledTimes(1);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: 'outbox-4' }),
      'order event missing amountMinor/currency -- skipping revenue rollup',
    );
  });

  it('skips reprocessing (no hincrby) but still ACKs a message already marked processed by THIS group', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(false);
    const message: [string, string[]] = [
      '1-0',
      ['outboxId', 'outbox-5', 'aggregateType', 'order', 'aggregateId', 'order-4', 'eventType', 'order.paid', 'payload', '{}'],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.hincrby).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith('stream:domain-events', 'analytics', '1-0');
  });

  it('subtracts revenue for order.refunded, so the dashboard reports net revenue', async () => {
    vi.mocked(tryMarkEventProcessed).mockResolvedValue(true);
    const message: [string, string[]] = [
      '1-0',
      [
        'outboxId', 'outbox-5',
        'aggregateType', 'order',
        'aggregateId', 'order-1',
        'eventType', 'order.refunded',
        'payload', JSON.stringify({ orderId: 'order-1', amountMinor: '150000', currency: 'INR' }),
      ],
    ];
    const redis = fakeRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([['stream:domain-events', [message]]])
        .mockImplementation(delayedNull(null)),
    });

    const consumer = startAnalyticsConsumer(redis, silentLogger);
    await vi.waitFor(() => expect(redis.xack).toHaveBeenCalled(), { timeout: 2000 });
    await consumer.stop();

    expect(redis.hincrby).toHaveBeenCalledWith('analytics:revenueMinorByCurrency', 'INR', '-150000');
  });
});
