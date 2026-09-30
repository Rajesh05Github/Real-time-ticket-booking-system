import { NOTIFICATION_FEED_MAX_LENGTH } from '@flashsale/shared';

import { redisKeys } from './keys.js';

import type { Redis } from './client.js';

export interface FeedEntry {
  id: string;
  type: string;
  createdAt: string;
}

/**
 * Lives in packages/redis, not apps/api, as of Phase 11 -- originally
 * built in Phase 7 for apps/api's OTP-notification flow alone, moved here
 * for the exact reason recordAuditLog/writeOutboxEvent live in
 * packages/database: apps/worker's new domain-event consumer
 * (apps/worker/src/consumers/domain-event-consumer.ts) needs to push to
 * this SAME feed for reservation lifecycle events, and apps/worker cannot
 * import apps/api's code. One implementation, two callers, not two
 * independently-maintained copies.
 *
 * `LPUSH` + `LTRIM` in one call (not two separate round trips): pushing
 * onto the head and immediately trimming to the max length is the
 * standard Redis idiom for "capped recent-items list" -- it keeps the
 * list from growing unboundedly for a user who accumulates thousands of
 * notifications over time, without needing a separate cleanup job.
 *
 * Fails OPEN, same principle as apps/api's event-cache.ts: this is a fast
 * VIEW over the durable Postgres Notification row (docs/database.md) or,
 * as of Phase 11, over a domain event already durably recorded in
 * outbox_events -- never a second source of truth. A Redis hiccup here
 * must never fail whatever request or consume loop is calling it.
 */
export async function pushToRecentFeed(redis: Redis, userId: string, entry: FeedEntry): Promise<void> {
  const key = redisKeys.notificationsFeed(userId);
  await redis
    .multi()
    .lpush(key, JSON.stringify(entry))
    .ltrim(key, 0, NOTIFICATION_FEED_MAX_LENGTH - 1)
    .exec()
    .catch(() => undefined);
}

/**
 * Returns the most recent entries, newest first (LPUSH means index 0 is
 * always the latest push). Returns an empty array -- not an error -- on
 * a Redis failure or a malformed entry, since this is a "nice to have"
 * read, not a correctness-critical one.
 */
export async function getRecentFeed(redis: Redis, userId: string): Promise<FeedEntry[]> {
  const raw = await redis.lrange(redisKeys.notificationsFeed(userId), 0, -1).catch(() => []);

  const entries: FeedEntry[] = [];
  for (const item of raw) {
    try {
      entries.push(JSON.parse(item) as FeedEntry);
    } catch {
      // A single corrupted entry (should never happen in practice, since
      // this module is the only writer) doesn't invalidate the rest of
      // the feed -- skip it and keep going.
    }
  }
  return entries;
}
