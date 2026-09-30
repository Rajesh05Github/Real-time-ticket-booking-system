import type { Redis } from './client.js';

/**
 * Fixed-window rate limiting (section 20), atomic via a single Lua
 * script rather than a separate INCR + EXPIRE round trip.
 *
 * Why atomicity matters here specifically: INCR's return value alone is
 * enough to tell exactly one caller "you created this key" (only one
 * concurrent INCR can ever see the count go 0->1), so a naive
 * `if (count === 1) await redis.expire(...)` isn't racy in the sense of
 * two callers both setting it. It's racy in a different, easier-to-miss
 * way: if the process crashes (or the connection drops) in the gap
 * between the INCR resolving and the EXPIRE call, the key survives with
 * NO ttl at all -- silently rate-limiting that IP/bucket forever until a
 * manual DEL. Bundling both commands into one EVAL removes that gap
 * entirely: either both run, or (on a connection failure) neither did.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still permitted in the current window; 0 once exhausted. */
  remaining: number;
  /** Seconds until the window resets -- becomes the client's Retry-After. */
  retryAfterSeconds: number;
}

/**
 * Consumes one request against `key`'s fixed window. Fails OPEN: if
 * Redis is unreachable, the caller gets `allowed: true` rather than a
 * thrown error -- a rate limiter is a defense-in-depth measure, not a
 * correctness boundary (unlike the seat-locking unique index), and it
 * should never be the reason a Redis blip takes down login/register
 * entirely. See docs/redis.md for the project's fail-open/fail-closed
 * split.
 */
export async function consumeRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const [count, ttl] = (await redis.eval(FIXED_WINDOW_SCRIPT, 1, key, windowSeconds)) as [
      number,
      number,
    ];
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      // TTL can come back -1/-2 only in a state this script never
      // produces (a key with no expiry, or one that vanished between the
      // EVAL and this read) -- windowSeconds is the correct fallback either
      // way, since that's the longest the caller could actually be blocked.
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  } catch {
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}
