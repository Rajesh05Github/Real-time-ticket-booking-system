import { redisKeys, type Redis } from '@flashsale/redis';

/**
 * Join/leave for Phase 15's real-time viewer count -- see
 * packages/redis/src/keys.ts's `eventLivePresence` entry for why this is
 * a SEPARATE Set from Phase 7's `eventWatchers` (persistent, explicit
 * "watch" action) despite both being Sets scoped to one event. Presence
 * membership is keyed by a per-CONNECTION id, generated fresh for every
 * WebSocket connection (apps/api/src/modules/events/event-live.routes.ts)
 * -- not userId, so two tabs from the same person correctly count as two
 * viewers.
 *
 * Fails OPEN, same principle as event-engagement.ts's view counter: a
 * viewer count is a nice-to-have display number, never a correctness
 * boundary, so a Redis hiccup must never break the WebSocket connection
 * itself. Returns `null` (not `0`) on failure specifically so callers
 * can tell "genuinely zero viewers" apart from "couldn't find out" and
 * skip broadcasting a bogus count in the latter case.
 */
export async function joinPresence(redis: Redis, eventId: string, connectionId: string): Promise<number | null> {
  const key = redisKeys.eventLivePresence(eventId);
  try {
    await redis.sadd(key, connectionId);
    return await redis.scard(key);
  } catch {
    return null;
  }
}

export async function leavePresence(redis: Redis, eventId: string, connectionId: string): Promise<number | null> {
  const key = redisKeys.eventLivePresence(eventId);
  try {
    await redis.srem(key, connectionId);
    return await redis.scard(key);
  } catch {
    return null;
  }
}
