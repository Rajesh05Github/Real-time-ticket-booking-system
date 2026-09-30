import { describe, expect, it, vi } from 'vitest';

import {
  getOrSetEventCache,
  getOrSetEventListCache,
  hashListQuery,
  invalidateEventCache,
  invalidateEventListCache,
} from './event-cache.js';

import type { Event } from '@flashsale/database';
import type { Redis } from '@flashsale/redis';

const fakeEvent = { id: 'evt-1', name: 'Test Event', status: 'PUBLISHED' } as unknown as Event;

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

describe('getOrSetEventCache', () => {
  it('returns the cached value on a HIT without touching the database', async () => {
    const redis = fakeRedis({ get: vi.fn().mockResolvedValue(JSON.stringify(fakeEvent)) });
    const loadFromDatabase = vi.fn();

    const result = await getOrSetEventCache(redis, 'evt-1', loadFromDatabase);

    expect(result).toEqual(fakeEvent);
    expect(loadFromDatabase).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('on a MISS, queries the database, populates the cache, and returns the event', async () => {
    const redis = fakeRedis(); // get() resolves null by default -- a miss
    const loadFromDatabase = vi.fn().mockResolvedValue(fakeEvent);

    const result = await getOrSetEventCache(redis, 'evt-1', loadFromDatabase);

    expect(result).toEqual(fakeEvent);
    expect(loadFromDatabase).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'cache:event:evt-1',
      JSON.stringify(fakeEvent),
      'EX',
      expect.any(Number),
    );
  });

  it('never caches a null result (event not found / not publicly visible)', async () => {
    const redis = fakeRedis();
    const loadFromDatabase = vi.fn().mockResolvedValue(null);

    const result = await getOrSetEventCache(redis, 'evt-1', loadFromDatabase);

    expect(result).toBeNull();
    // `set` IS still called once here -- for acquiring the rebuild lock
    // (`lock:cache:event:evt-1`), which is expected and correct. What
    // must never happen is a `set` against the actual cache key with
    // the null result serialized into it.
    expect(redis.set).not.toHaveBeenCalledWith(
      'cache:event:evt-1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('releases the stampede lock after a successful rebuild', async () => {
    const redis = fakeRedis();
    await getOrSetEventCache(redis, 'evt-1', vi.fn().mockResolvedValue(fakeEvent));

    expect(redis.del).toHaveBeenCalledWith('lock:cache:event:evt-1');
  });

  it('waits and re-checks the cache when another request already holds the rebuild lock', async () => {
    // First get(): miss. set(...NX) for the lock: fails (someone else
    // holds it). Second get() (the retry): hit -- simulating that the
    // other request finished repopulating the cache while we waited.
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(fakeEvent));
    const redis = fakeRedis({ get, set: vi.fn().mockResolvedValue(null) });
    const loadFromDatabase = vi.fn();

    const result = await getOrSetEventCache(redis, 'evt-1', loadFromDatabase);

    expect(result).toEqual(fakeEvent);
    // Never became the rebuilder, so it must never call the loader or
    // try to write the cache itself.
    expect(loadFromDatabase).not.toHaveBeenCalled();
  });

  it('fails OPEN when Redis is unreachable: still returns the database result', async () => {
    // Every Redis call rejects -- simulates a Redis outage. Per section
    // 44, a cache is a performance optimization, never a correctness
    // boundary: this must degrade to a plain database read, not error.
    const redis = fakeRedis({
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const loadFromDatabase = vi.fn().mockResolvedValue(fakeEvent);

    const result = await getOrSetEventCache(redis, 'evt-1', loadFromDatabase);

    expect(result).toEqual(fakeEvent);
    expect(loadFromDatabase).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateEventCache', () => {
  it('deletes the correct cache key', async () => {
    const redis = fakeRedis();
    await invalidateEventCache(redis, 'evt-1');
    expect(redis.del).toHaveBeenCalledWith('cache:event:evt-1');
  });

  it('fails open (does not throw) when Redis is unreachable', async () => {
    const redis = fakeRedis({ del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    await expect(invalidateEventCache(redis, 'evt-1')).resolves.toBeUndefined();
  });
});

describe('hashListQuery', () => {
  it('is independent of key order and ignores undefined filters', () => {
    expect(hashListQuery({ page: 1, search: 'x', venueId: undefined })).toBe(hashListQuery({ search: 'x', page: 1 }));
  });

  it('distinguishes different queries', () => {
    expect(hashListQuery({ page: 1 })).not.toBe(hashListQuery({ page: 2 }));
  });
});

describe('getOrSetEventListCache', () => {
  const listResult = { events: [fakeEvent], total: 1 };

  it('on a MISS, loads from the database and caches under the CURRENT generation', async () => {
    const redis = fakeRedis({
      get: vi.fn().mockImplementation((key: string) =>
        Promise.resolve(key === 'cache:events:list:generation' ? '7' : null),
      ),
    });
    const loadFromDatabase = vi.fn().mockResolvedValue(listResult);

    const result = await getOrSetEventListCache(redis, { page: 1 }, loadFromDatabase);

    expect(result).toEqual(listResult);
    expect(redis.set).toHaveBeenCalledWith(
      `cache:events:list:7:${hashListQuery({ page: 1 })}`,
      JSON.stringify(listResult),
      'EX',
      expect.any(Number),
    );
  });

  it('on a HIT, returns the cached page without touching the database', async () => {
    const redis = fakeRedis({
      get: vi.fn().mockImplementation((key: string) =>
        Promise.resolve(key === 'cache:events:list:generation' ? '7' : JSON.stringify(listResult)),
      ),
    });
    const loadFromDatabase = vi.fn();

    const result = await getOrSetEventListCache(redis, { page: 1 }, loadFromDatabase);

    expect(result).toEqual(listResult);
    expect(loadFromDatabase).not.toHaveBeenCalled();
  });

  it('fails OPEN when Redis is unreachable', async () => {
    const redis = fakeRedis({
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const loadFromDatabase = vi.fn().mockResolvedValue(listResult);

    await expect(getOrSetEventListCache(redis, { page: 1 }, loadFromDatabase)).resolves.toEqual(listResult);
  });
});

describe('invalidateEventListCache', () => {
  it('bumps the generation counter (orphaning every cached page at once)', async () => {
    const redis = fakeRedis({ incr: vi.fn().mockResolvedValue(8) });
    await invalidateEventListCache(redis);
    expect(redis.incr).toHaveBeenCalledWith('cache:events:list:generation');
  });

  it('fails open (does not throw) when Redis is unreachable', async () => {
    const redis = fakeRedis({ incr: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    await expect(invalidateEventListCache(redis)).resolves.toBeUndefined();
  });
});
