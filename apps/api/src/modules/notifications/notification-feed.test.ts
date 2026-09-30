import { getRecentFeed, pushToRecentFeed, type Redis } from '@flashsale/redis';
import { describe, expect, it, vi } from 'vitest';

const entry = { id: 'notif-1', type: 'otp_verification', createdAt: '2026-01-01T00:00:00.000Z' };

describe('pushToRecentFeed', () => {
  it('LPUSHes the entry and LTRIMs to the max length in one pipeline', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const ltrim = vi.fn().mockReturnValue({ exec });
    const lpush = vi.fn().mockReturnValue({ ltrim });
    const multi = vi.fn().mockReturnValue({ lpush });
    const redis = { multi } as unknown as Redis;

    await pushToRecentFeed(redis, 'user-1', entry);

    expect(lpush).toHaveBeenCalledWith('notifications:user:user-1', JSON.stringify(entry));
    expect(ltrim).toHaveBeenCalledWith('notifications:user:user-1', 0, 49);
  });

  it('fails open (does not throw) when Redis is unreachable', async () => {
    // Realistic failure shape: ioredis's `.multi()` only ever QUEUES
    // commands and never throws synchronously -- a real connection
    // failure surfaces when `.exec()` sends the pipeline and rejects.
    const exec = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ltrim = vi.fn().mockReturnValue({ exec });
    const lpush = vi.fn().mockReturnValue({ ltrim });
    const multi = vi.fn().mockReturnValue({ lpush });
    const redis = { multi } as unknown as Redis;

    await expect(pushToRecentFeed(redis, 'user-1', entry)).resolves.toBeUndefined();
  });
});

describe('getRecentFeed', () => {
  it('parses each JSON entry, newest first (LPUSH order)', async () => {
    const newer = { ...entry, id: 'notif-2' };
    const redis = {
      lrange: vi.fn().mockResolvedValue([JSON.stringify(newer), JSON.stringify(entry)]),
    } as unknown as Redis;

    const feed = await getRecentFeed(redis, 'user-1');

    expect(feed).toEqual([newer, entry]);
    expect(redis.lrange).toHaveBeenCalledWith('notifications:user:user-1', 0, -1);
  });

  it('skips a corrupted entry instead of failing the whole feed', async () => {
    const redis = {
      lrange: vi.fn().mockResolvedValue(['not valid json', JSON.stringify(entry)]),
    } as unknown as Redis;

    const feed = await getRecentFeed(redis, 'user-1');

    expect(feed).toEqual([entry]);
  });

  it('returns an empty array when Redis is unreachable (fails open)', async () => {
    const redis = { lrange: vi.fn().mockRejectedValue(new Error('down')) } as unknown as Redis;
    const feed = await getRecentFeed(redis, 'user-1');
    expect(feed).toEqual([]);
  });
});
