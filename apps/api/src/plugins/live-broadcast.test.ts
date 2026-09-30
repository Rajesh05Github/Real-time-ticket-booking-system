import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RedisModule from '@flashsale/redis';

vi.mock('@flashsale/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisModule>();
  return { ...actual, createRedisClient: vi.fn() };
});

const { createRedisClient } = await import('@flashsale/redis');
const { liveBroadcastPlugin } = await import('./live-broadcast.js');

type Handler = (...args: unknown[]) => void;

function fakeSubscriberRedis() {
  const handlers = new Map<string, Handler[]>();
  return {
    on: vi.fn((event: string, cb: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
  };
}

describe('liveBroadcastPlugin', () => {
  let app: FastifyInstance;
  let subscriberRedis: ReturnType<typeof fakeSubscriberRedis>;
  let appRedis: { publish: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    subscriberRedis = fakeSubscriberRedis();
    vi.mocked(createRedisClient).mockReturnValue(subscriberRedis as never);

    app = Fastify();
    appRedis = { publish: vi.fn().mockResolvedValue(1) };
    app.decorate('redis', appRedis as never);
    await app.register(liveBroadcastPlugin);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('issues a real Redis SUBSCRIBE only on the FIRST listener for a channel', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    app.liveBroadcast.subscribe('event:evt-1:live', listenerA);
    app.liveBroadcast.subscribe('event:evt-1:live', listenerB);

    expect(subscriberRedis.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriberRedis.subscribe).toHaveBeenCalledWith('event:evt-1:live');
  });

  it('issues a real Redis UNSUBSCRIBE only once the LAST listener for a channel leaves', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    app.liveBroadcast.subscribe('event:evt-1:live', listenerA);
    app.liveBroadcast.subscribe('event:evt-1:live', listenerB);

    app.liveBroadcast.unsubscribe('event:evt-1:live', listenerA);
    expect(subscriberRedis.unsubscribe).not.toHaveBeenCalled();

    app.liveBroadcast.unsubscribe('event:evt-1:live', listenerB);
    expect(subscriberRedis.unsubscribe).toHaveBeenCalledWith('event:evt-1:live');
  });

  it('dispatches an incoming message to every locally-registered listener for that channel, and no others', () => {
    const evt1Listener = vi.fn();
    const evt2Listener = vi.fn();
    app.liveBroadcast.subscribe('event:evt-1:live', evt1Listener);
    app.liveBroadcast.subscribe('event:evt-2:live', evt2Listener);

    subscriberRedis.emit('message', 'event:evt-1:live', '{"type":"viewerCount","count":3}');

    expect(evt1Listener).toHaveBeenCalledWith('{"type":"viewerCount","count":3}');
    expect(evt2Listener).not.toHaveBeenCalled();
  });

  it('publish() uses app.redis (never the dedicated subscriber connection)', async () => {
    await app.liveBroadcast.publish('event:evt-1:live', 'payload');
    expect(appRedis.publish).toHaveBeenCalledWith('event:evt-1:live', 'payload');
  });

  it('publish() fails open: a Redis error never throws out of the call', async () => {
    appRedis.publish.mockRejectedValue(new Error('down'));
    await expect(app.liveBroadcast.publish('event:evt-1:live', 'payload')).resolves.toBeUndefined();
  });

  it('disconnects the subscriber connection when the app closes', async () => {
    await app.close();
    expect(subscriberRedis.disconnect).toHaveBeenCalled();
  });
});
