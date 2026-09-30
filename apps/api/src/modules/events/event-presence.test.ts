import { describe, expect, it, vi } from 'vitest';

import { joinPresence, leavePresence } from './event-presence.js';

import type { Redis } from '@flashsale/redis';

function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as Redis;
}

describe('joinPresence', () => {
  it('SADDs the connection id and returns the new SCARD count', async () => {
    const redis = fakeRedis({ scard: vi.fn().mockResolvedValue(3) });

    const count = await joinPresence(redis, 'evt-1', 'conn-1');

    expect(redis.sadd).toHaveBeenCalledWith('presence:event:evt-1', 'conn-1');
    expect(count).toBe(3);
  });

  it('fails open (returns null, not 0) on a Redis error -- distinguishable from a real zero count', async () => {
    const redis = fakeRedis({ sadd: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(joinPresence(redis, 'evt-1', 'conn-1')).resolves.toBeNull();
  });
});

describe('leavePresence', () => {
  it('SREMs the connection id and returns the new SCARD count', async () => {
    const redis = fakeRedis({ scard: vi.fn().mockResolvedValue(1) });

    const count = await leavePresence(redis, 'evt-1', 'conn-1');

    expect(redis.srem).toHaveBeenCalledWith('presence:event:evt-1', 'conn-1');
    expect(count).toBe(1);
  });

  it('fails open (returns null) on a Redis error', async () => {
    const redis = fakeRedis({ srem: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(leavePresence(redis, 'evt-1', 'conn-1')).resolves.toBeNull();
  });
});
