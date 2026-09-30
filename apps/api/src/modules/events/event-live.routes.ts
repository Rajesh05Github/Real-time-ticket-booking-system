import { randomUUID } from 'node:crypto';

import { redisKeys } from '@flashsale/redis';

import { type LiveMessageListener } from '../../plugins/live-broadcast.js';

import { joinPresence, leavePresence } from './event-presence.js';
import { eventIdParamsSchema } from './event.schema.js';
import { assertEventVisibleToViewer } from './event.service.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Same visibility rule as `getEventForViewer` (Phase 6): a non-PUBLISHED
 * event 404s rather than exposing that it exists at all. Run as an
 * ordinary `preHandler`, BEFORE the WebSocket upgrade -- a rejected
 * request here never opens a socket at all, it's just a normal HTTP 404,
 * the same as it would be for the REST event-detail endpoint.
 *
 * Delegates to `event.service.ts`'s `assertEventVisibleToViewer` (Phase
 * 22's frontend build extracted it once three call sites had each
 * duplicated this same check) rather than `getEventForViewer` -- this
 * route has no session, so `viewerRole` is always `undefined`, and using
 * `getEventForViewer` here would also record a page VIEW and touch the
 * event cache for what is really just a visibility gate before a socket
 * upgrade.
 */
async function ensureEventIsLive(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const { eventId } = eventIdParamsSchema.parse(request.params);
  await assertEventVisibleToViewer(eventId, undefined);
}

/**
 * `GET /api/v1/events/:eventId/live` -- a WebSocket, not a REST route
 * (registered with `{ websocket: true }`; the handler receives the raw
 * `ws` socket directly, current `@fastify/websocket` API). No auth
 * preHandler at all -- fully public, like the REST detail endpoint it
 * sits next to: watching a live viewer count needs no more identity
 * than viewing the event page itself does, and nothing in this handler
 * reads `request.session` (a future feature that needed to know WHO is
 * watching, not just how many, would be the point to add `optionalAuth`
 * back -- not before then).
 *
 * The full lifecycle, section 8's "tell whoever's listening right now"
 * made concrete:
 *
 *  1. SUBSCRIBE this connection (via the shared plugin-level listener
 *     registry, not a new Redis connection per socket) to this event's
 *     live channel FIRST, before touching presence at all -- so this
 *     connection's own upcoming join is guaranteed to be delivered back
 *     to itself through the exact same path every OTHER instance's
 *     connections receive it through, rather than needing a separate
 *     "send the current count once" special case.
 *  2. Join presence (SADD a fresh per-connection id) and PUBLISH the new
 *     count -- every subscriber of this channel, on this instance and
 *     every other one, receives it, including this connection itself
 *     (step 1).
 *  3. On close: leave presence (SREM) and publish the new count the same
 *     way, then unsubscribe.
 */
export function eventLiveRoutes(app: FastifyInstance): void {
  app.get('/:eventId/live', { preHandler: ensureEventIsLive, websocket: true }, (socket, request) => {
    const { eventId } = eventIdParamsSchema.parse(request.params);
    const connectionId = randomUUID();
    const channel = redisKeys.eventLiveChannel(eventId);

    const onMessage: LiveMessageListener = (payload) => {
      socket.send(payload);
    };
    app.liveBroadcast.subscribe(channel, onMessage);

    void (async () => {
      const count = await joinPresence(app.redis, eventId, connectionId);
      if (count !== null) {
        await app.liveBroadcast.publish(channel, JSON.stringify({ type: 'viewerCount', count }));
      }
    })();

    socket.on('close', () => {
      app.liveBroadcast.unsubscribe(channel, onMessage);
      void (async () => {
        const count = await leavePresence(app.redis, eventId, connectionId);
        if (count !== null) {
          await app.liveBroadcast.publish(channel, JSON.stringify({ type: 'viewerCount', count }));
        }
      })();
    });
  });
}
