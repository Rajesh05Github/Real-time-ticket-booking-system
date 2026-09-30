/**
 * Phase 7: List/Set/Sorted-Set-backed engagement features (section 12,
 * 15, 16).
 */

/** LTRIM bound for notifications:user:{userId} -- see packages/redis's
 * key registry for why this is length-bounded, not TTL-bounded. */
export const NOTIFICATION_FEED_MAX_LENGTH = 50;

/** Default number of events returned by GET /events/trending when the
 * caller doesn't specify `?limit=`. */
export const TRENDING_EVENTS_DEFAULT_LIMIT = 10;

/** Upper bound on `?limit=` -- prevents a single request from pulling an
 * unbounded ZREVRANGE result and the N Postgres rows that follow it. */
export const TRENDING_EVENTS_MAX_LIMIT = 50;
