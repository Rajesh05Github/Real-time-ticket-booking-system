import { Redis } from 'ioredis';

/**
 * General-purpose app Redis client (cache, OTP, sessions, and -- from
 * Phase 7 onward -- counters, sets, sorted sets, streams, pub/sub).
 *
 * Module-scoped singleton for the same reason as @flashsale/database's
 * PrismaClient (packages/database/src/client.ts): one connection per
 * process, not one per call site. apps/api and apps/worker both run
 * under `tsx watch`, which restarts the whole process on file change, so
 * there's no hot-reload-duplicate-instance problem to guard against here.
 */
export interface CreateRedisClientOptions {
  /**
   * Bounds how long any single command waits before erroring out instead
   * of sitting in `enableOfflineQueue`'s queue indefinitely -- see the
   * comment below for why this is opt-in, not a blanket default.
   */
  commandTimeout?: number;
}

export function createRedisClient(url: string, options: CreateRedisClientOptions = {}): Redis {
  return new Redis(url, {
    // Reconnect with capped exponential backoff rather than giving up --
    // a transient Redis restart shouldn't require restarting the app.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
    // Queue commands issued while disconnected instead of throwing
    // immediately; they flush once the connection recovers. Combined with
    // the app-level "Redis down" fallbacks documented per-feature in
    // docs/redis.md (Phase 7+), this keeps a brief Redis blip from
    // cascading into hard request failures everywhere.
    enableOfflineQueue: true,
    // OPT-IN, not a default: found live in Phase 19's failure testing --
    // with Redis stopped, a plain `GET /api/v1/me` (one `HGETALL`) hung
    // well past 8 seconds with no response, instead of failing fast, on
    // apps/api's general-purpose client. `commandTimeout` fixes that for
    // request-path clients (see apps/api/src/plugins/redis.ts,
    // live-broadcast.ts), letting this codebase's fail-open try/catch
    // blocks (seat locks, rate limiting, event cache, live presence)
    // actually fire instead of never getting the chance to.
    //
    // It CANNOT be a blanket default here, though: apps/worker's stream
    // consumers (domain-event-consumer.ts, analytics-consumer.ts) call
    // `createRedisClient` for a connection that deliberately issues
    // `XREADGROUP ... BLOCK 5000` -- a legitimate 5-SECOND wait for new
    // stream entries under completely normal, healthy operation. A
    // blanket 2s `commandTimeout` would misfire on every single idle
    // poll cycle, not just real outages.
    ...(options.commandTimeout !== undefined ? { commandTimeout: options.commandTimeout } : {}),
  });
}

/**
 * A SEPARATE connection for BullMQ, not a shared reference to the general
 * client above. BullMQ's docs are explicit about this: it needs
 * `maxRetriesPerRequest: null` (it manages its own retry/blocking-command
 * semantics for queue polling) and `enableReadyCheck: false`, neither of
 * which are correct settings for general request-path Redis usage. Using
 * one shared client for both would either break BullMQ's blocking reads
 * or silently disable retry behavior the rest of the app relies on.
 */
export function createBullMQConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export type { Redis };
