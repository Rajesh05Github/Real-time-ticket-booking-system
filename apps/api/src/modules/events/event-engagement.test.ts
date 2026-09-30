import { describe, expect, it, vi } from 'vitest';

import {
  addWatcher,
  getTrendingEventIds,
  getWatchStatus,
  recordEventView,
  removeFromTrending,
  removeWatcher,
} from './event-engagement.js';

import type { Redis } from '@flashsale/redis';

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    sismember: vi.fn().mockResolvedValue(0),
    scard: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    zincrby: vi.fn().mockResolvedValue('1'),
    zrem: vi.fn().mockResolvedValue(1),
    zrevrange: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Redis;
}

describe('watchers (Set)', () => {
  it('addWatcher calls SADD with the correct key and member', async () => {
    const redis = fakeRedis();
    await addWatcher(redis, 'evt-1', 'user-1');
    expect(redis.sadd).toHaveBeenCalledWith('event:evt-1:watchers', 'user-1');
  });

  it('removeWatcher calls SREM with the correct key and member', async () => {
    const redis = fakeRedis();
    await removeWatcher(redis, 'evt-1', 'user-1');
    expect(redis.srem).toHaveBeenCalledWith('event:evt-1:watchers', 'user-1');
  });

  it('getWatchStatus reports both membership and total count', async () => {
    const redis = fakeRedis({
      sismember: vi.fn().mockResolvedValue(1),
      scard: vi.fn().mockResolvedValue(7),
    });

    const status = await getWatchStatus(redis, 'evt-1', 'user-1');

    expect(status).toEqual({ isWatching: true, watcherCount: 7 });
  });

  it('getWatchStatus reports isWatching=false when SISMEMBER returns 0', async () => {
    const redis = fakeRedis({ sismember: vi.fn().mockResolvedValue(0) });
    const status = await getWatchStatus(redis, 'evt-1', 'user-1');
    expect(status.isWatching).toBe(false);
  });
});

describe('view counter + trending (String + Sorted Set)', () => {
  it('recordEventView increments both the counter and the sorted set score', async () => {
    const redis = fakeRedis();
    await recordEventView(redis, 'evt-1');

    expect(redis.incr).toHaveBeenCalledWith('event:evt-1:views');
    expect(redis.zincrby).toHaveBeenCalledWith('event:trending', 1, 'evt-1');
  });

  it('recordEventView fails open if the counter INCR rejects', async () => {
    const redis = fakeRedis({ incr: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(recordEventView(redis, 'evt-1')).resolves.toBeUndefined();
    // The independent ZINCRBY still ran despite INCR failing -- the two
    // writes are deliberately not coupled to each other's success.
    expect(redis.zincrby).toHaveBeenCalled();
  });

  it('recordEventView fails open if the ZINCRBY rejects', async () => {
    const redis = fakeRedis({ zincrby: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(recordEventView(redis, 'evt-1')).resolves.toBeUndefined();
    expect(redis.incr).toHaveBeenCalled();
  });

  it('removeFromTrending calls ZREM with the trending key and eventId', async () => {
    const redis = fakeRedis();
    await removeFromTrending(redis, 'evt-1');
    expect(redis.zrem).toHaveBeenCalledWith('event:trending', 'evt-1');
  });

  it('removeFromTrending fails open on a Redis error', async () => {
    const redis = fakeRedis({ zrem: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(removeFromTrending(redis, 'evt-1')).resolves.toBeUndefined();
  });

  it('getTrendingEventIds parses the flat [id, score, id, score, ...] reply into pairs', async () => {
    const redis = fakeRedis({
      zrevrange: vi.fn().mockResolvedValue(['evt-2', '15', 'evt-1', '9']),
    });

    const result = await getTrendingEventIds(redis, 10);

    expect(result).toEqual([
      { eventId: 'evt-2', score: 15 },
      { eventId: 'evt-1', score: 9 },
    ]);
    expect(redis.zrevrange).toHaveBeenCalledWith('event:trending', 0, 9, 'WITHSCORES');
  });

  it('getTrendingEventIds returns an empty array on a Redis error (fails open)', async () => {
    const redis = fakeRedis({ zrevrange: vi.fn().mockRejectedValue(new Error('down')) });
    const result = await getTrendingEventIds(redis, 10);
    expect(result).toEqual([]);
  });
});
