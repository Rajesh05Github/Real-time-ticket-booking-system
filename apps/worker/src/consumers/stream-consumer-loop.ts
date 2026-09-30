import { hostname } from 'node:os';

import { tryMarkEventProcessed } from '@flashsale/database';
import {
  STREAM_CONSUMER_BATCH_SIZE,
  STREAM_CONSUMER_BLOCK_MS,
  STREAM_CONSUMER_CLAIM_IDLE_MS,
} from '@flashsale/shared';

import type { Logger } from '@flashsale/logger';
import type { Redis } from '@flashsale/redis';

export interface ParsedDomainEvent {
  outboxId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export type StreamMessage = [id: string, fields: string[]];

export function parseMessage([id, fields]: StreamMessage): ParsedDomainEvent {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i] as string] = fields[i + 1] as string;
  }

  let payload: unknown;
  try {
    payload = map.payload !== undefined ? JSON.parse(map.payload) : undefined;
  } catch {
    payload = undefined;
  }

  return {
    outboxId: map.outboxId ?? id,
    aggregateType: map.aggregateType ?? 'unknown',
    aggregateId: map.aggregateId ?? 'unknown',
    eventType: map.eventType ?? 'unknown',
    payload,
  };
}

export interface StreamConsumerLoop {
  stop: () => Promise<void>;
}

export interface StreamConsumerLoopOptions {
  redis: Redis;
  logger: Logger;
  stream: string;
  group: string;
  /** Called once per event that this group hasn't already processed (a
   * redelivery of an already-processed event never reaches this -- the
   * loop ACKs it directly). Throwing here leaves the message un-ACKed so
   * XAUTOCLAIM's next pass retries it. */
  onNewEvent: (event: ParsedDomainEvent) => Promise<void>;
  /** Where a NEWLY CREATED group starts reading: '0' (default) replays
   * the whole retained stream, '$' starts from new entries only. Has no
   * effect once the group exists -- Redis keeps its cursor. */
  startFrom?: '0' | '$';
}

/**
 * The generic run loop shared by every Redis Streams consumer group in
 * this codebase: create-group/catch-up-from-'0', XAUTOCLAIM stale
 * pending entries, blocking XREADGROUP for new ones, mark-processed
 * dedup via the (group, outboxId) pair (packages/database's
 * ProcessedEvent, keyed on the outbox row's OWN id so redelivery is safe
 * regardless of the Redis-generated stream id), and ACK unconditionally
 * once a message is handled -- including a dedup-skip, which still
 * counts as "handled."
 *
 * Extracted in Phase 16 the moment a SECOND consumer group
 * (ANALYTICS_CONSUMER_GROUP) needed the exact same mechanics as Phase
 * 11's notification consumer -- see docs/streams.md, which flagged this
 * exact scenario as the whole reason consumer groups are independent:
 * two real call sites sharing one generic loop, each supplying only what
 * actually differs (`group` and `onNewEvent`).
 */
export function startStreamConsumerLoop(options: StreamConsumerLoopOptions): StreamConsumerLoop {
  const { redis, logger, stream, group, onNewEvent, startFrom = '0' } = options;
  const consumerName = `${hostname()}:${process.pid}`;

  let stopped = false;

  async function ensureConsumerGroup(): Promise<void> {
    try {
      // '0' by default: a brand-new group should catch up on everything
      // already in the stream, not just entries added from this point
      // forward (a live-only group like live-seats opts into '$').
      // MKSTREAM covers the (test/dev) case where the stream doesn't
      // exist yet at all.
      await redis.xgroup('CREATE', stream, group, startFrom, 'MKSTREAM');
      logger.info({ stream, group }, 'created consumer group');
    } catch (err) {
      // BUSYGROUP: the group already exists -- expected on every restart
      // after the first, not an error.
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  async function processMessage(message: StreamMessage): Promise<void> {
    const [id] = message;
    const event = parseMessage(message);

    const isNew = await tryMarkEventProcessed(group, event.outboxId);
    if (!isNew) {
      await redis.xack(stream, group, id);
      return;
    }

    await onNewEvent(event);
    await redis.xack(stream, group, id);
  }

  async function processMessages(messages: StreamMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await processMessage(message);
      } catch (err) {
        // Deliberately NOT acked on failure -- it stays in the group's
        // Pending Entries List and either this consumer or, if it's this
        // one that's actually the problem, XAUTOCLAIM's next pass
        // reassigns it to a healthier consumer after
        // STREAM_CONSUMER_CLAIM_IDLE_MS.
        logger.error({ err, group, messageId: message[0] }, 'failed to process stream message');
      }
    }
  }

  async function claimStaleMessages(): Promise<void> {
    const result = (await redis.xautoclaim(
      stream,
      group,
      consumerName,
      STREAM_CONSUMER_CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      STREAM_CONSUMER_BATCH_SIZE,
    )) as [string, StreamMessage[], ...unknown[]];

    const [, claimed] = result;
    if (claimed.length > 0) {
      logger.warn({ count: claimed.length, group, consumerName }, 'reclaimed stale pending stream entries');
      await processMessages(claimed);
    }
  }

  async function readNewMessages(): Promise<void> {
    const result = (await redis.xreadgroup(
      'GROUP',
      group,
      consumerName,
      'COUNT',
      STREAM_CONSUMER_BATCH_SIZE,
      'BLOCK',
      STREAM_CONSUMER_BLOCK_MS,
      'STREAMS',
      stream,
      '>',
    )) as [string, StreamMessage[]][] | null;

    if (!result) {
      return; // BLOCK timed out with nothing new -- normal, not an error
    }

    for (const [, messages] of result) {
      await processMessages(messages);
    }
  }

  async function runLoop(): Promise<void> {
    await ensureConsumerGroup();

    while (!stopped) {
      try {
        await claimStaleMessages();
        if (stopped) break;
        await readNewMessages();
      } catch (err) {
        logger.error({ err, group }, 'stream consumer loop iteration failed');
        // Avoid a tight error loop hammering Redis/Postgres if something
        // is structurally broken (e.g. the stream or group got deleted).
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  const runPromise = runLoop();

  return {
    stop: async () => {
      stopped = true;
      await runPromise;
    },
  };
}
