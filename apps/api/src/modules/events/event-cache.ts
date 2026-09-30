import { createHash } from 'node:crypto';

import { redisKeys, type Redis } from '@flashsale/redis';
import {
  EVENT_CACHE_LOCK_TTL_SECONDS,
  EVENT_CACHE_STAMPEDE_MAX_RETRIES,
  EVENT_CACHE_STAMPEDE_RETRY_MS,
  EVENT_CACHE_TTL_SECONDS,
  EVENT_LIST_CACHE_TTL_SECONDS,
} from '@flashsale/shared';

import type { EventWithVenue } from './event.repository.js';

/**
 * What comes back out of Redis after a JSON round-trip: identical to
 * `Event`, except every `Date` field is the ISO string
 * `JSON.stringify`/`JSON.parse` actually produce, not a real `Date`
 * object. This is never a problem for what this codebase does with it
 * (the route handler just forwards it into `reply.send()`, which
 * JSON-serializes a `Date` into the exact same ISO string anyway) -- but
 * the type says so honestly instead of lying that a cached read returns
 * the same shape a fresh Postgres read does.
 */
export type SerializedEvent = Omit<EventWithVenue, 'startTime' | 'endTime' | 'createdAt' | 'updatedAt'> & {
  startTime: string;
  endTime: string | null;
  createdAt: string;
  updatedAt: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cache-aside read with stampede protection (section 4/section 5's
 * distributed-lock pattern, applied here to a cache rebuild instead of a
 * seat reservation). Every Redis call is wrapped to fail OPEN, not
 * closed: per section 44's "what happens if Redis fails" analysis, a
 * cache is a performance optimization, never a correctness boundary --
 * if Redis is unreachable, this degrades to a plain Postgres read on
 * every request rather than returning an error.
 *
 * `loadFromDatabase` returning `null` (event doesn't exist, or exists
 * but isn't publicly visible) is deliberately NEVER cached -- see
 * event.service.ts's caller for why only PUBLISHED events reach this
 * function at all, and docs/event-browsing.md for why caching a "not
 * found" result here isn't worth the added complexity at this scale.
 */
export async function getOrSetEventCache(
  redis: Redis,
  eventId: string,
  loadFromDatabase: () => Promise<EventWithVenue | null>,
): Promise<EventWithVenue | SerializedEvent | null> {
  const cacheKey = redisKeys.eventCache(eventId);

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    return JSON.parse(cached) as SerializedEvent;
  }

  const lockKey = redisKeys.eventCacheLock(eventId);
  const acquiredLock = await redis
    .set(lockKey, '1', 'EX', EVENT_CACHE_LOCK_TTL_SECONDS, 'NX')
    .catch(() => null);

  if (!acquiredLock) {
    // Someone else is already rebuilding this key -- wait briefly and
    // re-check rather than joining them in hitting Postgres. Bounded
    // retries, not a wait loop: worst case here is one extra Postgres
    // read per waiter, never an incorrect result and never an
    // indefinite block (the lock's own TTL guarantees forward progress
    // even if its holder crashed mid-rebuild).
    for (let attempt = 0; attempt < EVENT_CACHE_STAMPEDE_MAX_RETRIES; attempt += 1) {
      await sleep(EVENT_CACHE_STAMPEDE_RETRY_MS);
      const retried = await redis.get(cacheKey).catch(() => null);
      if (retried) {
        return JSON.parse(retried) as SerializedEvent;
      }
    }
  }

  try {
    const event = await loadFromDatabase();
    if (event) {
      await redis
        .set(cacheKey, JSON.stringify(event), 'EX', EVENT_CACHE_TTL_SECONDS)
        .catch(() => undefined);
    }
    return event;
  } finally {
    if (acquiredLock) {
      await redis.del(lockKey).catch(() => undefined);
    }
  }
}

/**
 * Called from every admin mutation that changes what GET
 * /events/:eventId would return (update, publish, unpublish) -- see
 * event.service.ts. Invalidate-on-write, not "wait for the TTL": a
 * stale cached copy of a just-unpublished event staying publicly
 * visible for up to EVENT_CACHE_TTL_SECONDS would be a real, visible
 * correctness bug, not just a performance nit.
 */
export async function invalidateEventCache(redis: Redis, eventId: string): Promise<void> {
  await redis.del(redisKeys.eventCache(eventId)).catch(() => undefined);
}

// ── Public list cache ─────────────────────────────────────────────────────

export interface CachedEventList {
  events: SerializedEvent[];
  total: number;
}

/**
 * Deterministic cache identity for one list query: keys sorted so
 * `?page=1&search=x` and `?search=x&page=1` share an entry, Dates as ISO
 * strings, absent filters omitted entirely.
 */
export function hashListQuery(query: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Cache-aside for the PUBLIC GET /events list (never an admin's, which
 * can include drafts). The list's query space is unbounded, so instead of
 * invalidating individual keys, every key embeds a generation number
 * (redisKeys.eventListGeneration) that any event write bumps -- one INCR
 * orphans every cached page at once, and orphans expire on their own
 * short TTL. Fails open exactly like the detail cache: any Redis error
 * degrades to a plain Postgres read.
 *
 * No stampede lock here, unlike the detail route: the list query is a
 * single indexed, paginated read (`@@index([status, startTime])`), and a
 * 30s TTL means a burst of concurrent misses is short-lived and bounded.
 */
export async function getOrSetEventListCache(
  redis: Redis,
  query: Record<string, unknown>,
  loadFromDatabase: () => Promise<{ events: EventWithVenue[]; total: number }>,
): Promise<{ events: (EventWithVenue | SerializedEvent)[]; total: number }> {
  const generation = await redis.get(redisKeys.eventListGeneration()).catch(() => null);
  const cacheKey = redisKeys.eventListCache(generation ?? '0', hashListQuery(query));

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    return JSON.parse(cached) as CachedEventList;
  }

  const result = await loadFromDatabase();
  await redis
    .set(cacheKey, JSON.stringify(result), 'EX', EVENT_LIST_CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return result;
}

/**
 * Called from every write that can change what a PUBLIC list page shows
 * (event update/publish/unpublish -- see event.service.ts).
 */
export async function invalidateEventListCache(redis: Redis): Promise<void> {
  await redis.incr(redisKeys.eventListGeneration()).catch(() => undefined);
}
