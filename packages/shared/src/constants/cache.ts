/**
 * Cache-aside tuning for GET /events/:eventId (Phase 6, section 4), and
 * for the public GET /events list (see EVENT_LIST_CACHE_TTL_SECONDS below
 * for how its unbounded query space is invalidated).
 */

/** How long a cached event stays fresh before falling back to Postgres. */
export const EVENT_CACHE_TTL_SECONDS = 300;

/**
 * Stampede-lock TTL -- short on purpose. This only needs to outlive one
 * Postgres query (the cache repopulation), not a whole request lifecycle.
 * A crashed lock holder self-heals via this TTL; nobody else blocks
 * waiting for an explicit release (see event-cache.ts).
 */
export const EVENT_CACHE_LOCK_TTL_SECONDS = 5;

/** How long a request waits between re-checking the cache while another
 * request holds the stampede lock and is repopulating it. */
export const EVENT_CACHE_STAMPEDE_RETRY_MS = 50;

/** After this many retries, give up waiting on the lock holder and read
 * Postgres directly instead -- never block indefinitely on a lock that,
 * worst case, might belong to a process that's already gone. */
export const EVENT_CACHE_STAMPEDE_MAX_RETRIES = 3;

/**
 * Public GET /events list cache. Keyed by a hash of the normalized query
 * PLUS a generation counter that every event/venue write bumps
 * (redisKeys.eventListGeneration) -- so invalidation is one INCR that
 * orphans every cached page at once, instead of hunting down an unbounded
 * set of query-shaped keys. The TTL only bounds how long orphaned keys
 * linger and how stale a page can be if an INCR is ever lost to a Redis
 * blip (the write paths fail open).
 */
export const EVENT_LIST_CACHE_TTL_SECONDS = 30;
