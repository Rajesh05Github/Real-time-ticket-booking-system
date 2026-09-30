import { redisKeys, type Redis } from '@flashsale/redis';

// ── Watchers (Set) ──────────────────────────────────────────────────────

export async function addWatcher(redis: Redis, eventId: string, userId: string): Promise<void> {
  await redis.sadd(redisKeys.eventWatchers(eventId), userId);
}

export async function removeWatcher(redis: Redis, eventId: string, userId: string): Promise<void> {
  await redis.srem(redisKeys.eventWatchers(eventId), userId);
}

export interface WatchStatus {
  isWatching: boolean;
  watcherCount: number;
}

/**
 * Two Set commands, not one -- `SISMEMBER` (is THIS user watching) and
 * `SCARD` (how many total) answer different questions and Redis has no
 * single command for both. Run concurrently since neither depends on
 * the other's result.
 */
export async function getWatchStatus(redis: Redis, eventId: string, userId: string): Promise<WatchStatus> {
  const key = redisKeys.eventWatchers(eventId);
  const [isWatching, watcherCount] = await Promise.all([
    redis.sismember(key, userId),
    redis.scard(key),
  ]);
  return { isWatching: isWatching === 1, watcherCount };
}

// ── View counter (String) + trending (Sorted Set) ────────────────────────

/**
 * Called once per non-admin event detail view (event.service.ts's
 * getEventForViewer). Two independent structures updated together on
 * purpose -- see packages/redis's key registry for why "total views" and
 * "rank against other events" aren't the same question and don't share
 * one Redis structure. Neither write depends on the other succeeding;
 * both fail open (a Redis hiccup here must never break viewing an
 * event), so they're issued as two independent, individually-caught
 * calls rather than one pipeline that could partially fail in a way
 * that's harder to reason about.
 */
export async function recordEventView(redis: Redis, eventId: string): Promise<void> {
  await Promise.all([
    redis.incr(redisKeys.eventViewCounter(eventId)).catch(() => undefined),
    redis.zincrby(redisKeys.eventTrending(), 1, eventId).catch(() => undefined),
  ]);
}

/** Called on unpublish so a no-longer-visible event stops appearing as
 * trending immediately, symmetric with Phase 6's cache invalidation. */
export async function removeFromTrending(redis: Redis, eventId: string): Promise<void> {
  await redis.zrem(redisKeys.eventTrending(), eventId).catch(() => undefined);
}

export interface TrendingEntry {
  eventId: string;
  score: number;
}

/**
 * `ZREVRANGE ... WITHSCORES` -- highest view count first. Returns Redis's
 * ranking only; event.service.ts is responsible for joining these ids
 * against Postgres to get displayable event data (this module has no
 * Postgres dependency, matching event-cache.ts's separation of "what
 * Redis says" from "what it means").
 */
export async function getTrendingEventIds(redis: Redis, limit: number): Promise<TrendingEntry[]> {
  const raw = await redis
    .zrevrange(redisKeys.eventTrending(), 0, limit - 1, 'WITHSCORES')
    .catch(() => []);

  const entries: TrendingEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const eventId = raw[i];
    const scoreStr = raw[i + 1];
    if (eventId !== undefined && scoreStr !== undefined) {
      entries.push({ eventId, score: Number(scoreStr) });
    }
  }
  return entries;
}
