import { createRedisClient, type Redis } from '@flashsale/redis';
import fp from 'fastify-plugin';

import { env } from '../env.js';

import type { FastifyInstance } from 'fastify';

export type LiveMessageListener = (payload: string) => void;

export interface LiveBroadcast {
  /** Publishes on the app's regular Redis client -- see this file's own
   * comment on why publishing and subscribing can never safely share one
   * connection. */
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, listener: LiveMessageListener): void;
  unsubscribe(channel: string, listener: LiveMessageListener): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    liveBroadcast: LiveBroadcast;
  }
}

/**
 * Phase 15's Pub/Sub fan-out, section 8's "tell whoever's listening
 * right now" finally exercised for real. Two things this plugin exists
 * to get right:
 *
 * 1. A SUBSCRIBEd Redis connection can do almost nothing else -- once a
 *    client issues SUBSCRIBE it enters a restricted mode where PUBLISH
 *    and most other commands aren't allowed on that same connection.
 *    That's why this plugin creates its OWN dedicated `subscriberRedis`
 *    (never used for anything but SUBSCRIBE/UNSUBSCRIBE) instead of
 *    reusing `app.redis`, the same "one connection, one job" discipline
 *    apps/worker's outbox publisher vs. domain-event-consumer split
 *    already established for BLOCK vs. ordinary commands (Phase 11).
 * 2. ONE subscriber connection for the whole process, not one per
 *    WebSocket client. Redis has no problem with many SUBSCRIBERS, but
 *    opening a whole new Redis connection per browser tab would be
 *    wasteful and doesn't scale -- this plugin instead maintains an
 *    in-memory `Map<channel, Set<listener>>` and only issues a real
 *    Redis SUBSCRIBE the first time a channel gains a listener (and
 *    UNSUBSCRIBE once the last one leaves), fanning each incoming
 *    message out to every locally-registered listener for that channel.
 */
export const liveBroadcastPlugin = fp((app: FastifyInstance) => {
  // Same commandTimeout reasoning as redis.ts's general client -- this
  // connection's own commands (SUBSCRIBE/UNSUBSCRIBE) are fast,
  // non-blocking calls, not a long BLOCK-style read, so it's safe to
  // bound the same way.
  const subscriberRedis: Redis = createRedisClient(env.REDIS_URL, { commandTimeout: 2000 });
  const listenersByChannel = new Map<string, Set<LiveMessageListener>>();

  subscriberRedis.on('message', (channel: string, payload: string) => {
    const listeners = listenersByChannel.get(channel);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(payload);
    }
  });

  subscriberRedis.on('error', (err) => {
    app.log.error({ err }, 'live-broadcast subscriber connection error');
  });

  const liveBroadcast: LiveBroadcast = {
    async publish(channel, payload) {
      await app.redis.publish(channel, payload).catch((err: unknown) => {
        // Fails open like every other Redis-dependent side channel in
        // this codebase: a dropped viewer-count update is a stale
        // number on someone's screen, never a broken WebSocket
        // connection or a broken request.
        app.log.warn({ err, channel }, 'failed to publish live broadcast message');
      });
    },

    subscribe(channel, listener) {
      let listeners = listenersByChannel.get(channel);
      if (!listeners) {
        listeners = new Set();
        listenersByChannel.set(channel, listeners);
        subscriberRedis.subscribe(channel).catch((err: unknown) => {
          app.log.error({ err, channel }, 'failed to subscribe to live broadcast channel');
        });
      }
      listeners.add(listener);
    },

    unsubscribe(channel, listener) {
      const listeners = listenersByChannel.get(channel);
      if (!listeners) {
        return;
      }
      listeners.delete(listener);
      if (listeners.size === 0) {
        listenersByChannel.delete(channel);
        subscriberRedis.unsubscribe(channel).catch((err: unknown) => {
          app.log.error({ err, channel }, 'failed to unsubscribe from live broadcast channel');
        });
      }
    },
  };

  app.decorate('liveBroadcast', liveBroadcast);

  app.addHook('onClose', () => {
    subscriberRedis.disconnect();
  });
});
