/**
 * Redis Streams consumer constants (Phase 11, section 8 continued).
 * Currently backs apps/worker's one consumer group; named per-group
 * (not just "the" consumer group) because a stream can have several
 * independent consumer groups reading it, each at its own pace.
 */

/**
 * The consumer group fanning domain events (stream:domain-events, Phase
 * 10) out to each affected user's notification feed (packages/redis's
 * notification-feed, Phase 7). Also used as ProcessedEvent's
 * `consumerGroup` column value for this group's dedup bookkeeping.
 */
export const NOTIFICATION_CONSUMER_GROUP = 'notifications';

/**
 * The second, fully independent consumer group reading the SAME
 * stream:domain-events stream (Phase 16) -- rolling up lifetime event
 * counters and paid-order revenue instead of fanning out to user feeds.
 * Exactly the scenario docs/streams.md flagged Phase 11 as deliberately
 * NOT building yet ("nothing stops a future phase from adding an
 * independent one... reading the same stream at its own pace"): a crash
 * or backlog in this group has zero effect on `notifications`'s delivery,
 * and vice versa, because consumer groups track their own cursor and
 * Pending Entries List per group.
 */
export const ANALYTICS_CONSUMER_GROUP = 'analytics';

/** How many stream entries one XREADGROUP call asks for at a time. */
export const STREAM_CONSUMER_BATCH_SIZE = 10;

/**
 * How long one XREADGROUP call blocks waiting for new entries before
 * returning empty-handed and looping again. This is also the rough
 * upper bound on how long a graceful shutdown can take to notice
 * `stop()` was called -- unlike the sweeper/publisher's `setInterval`
 * shape, this consumer is a continuous blocking-read loop, so "stop
 * waiting" means "let the current BLOCK call time out," not "clear a
 * timer."
 */
export const STREAM_CONSUMER_BLOCK_MS = 5_000;

/**
 * How long a message can sit unacknowledged in the consumer group's
 * Pending Entries List before XAUTOCLAIM considers its original
 * consumer dead and reassigns it to whichever consumer asks. Well above
 * STREAM_CONSUMER_BLOCK_MS and any realistic single-message processing
 * time -- this should only ever trigger for a consumer that actually
 * crashed mid-message, not a slow-but-alive one.
 */
export const STREAM_CONSUMER_CLAIM_IDLE_MS = 30_000;

/**
 * Third independent consumer group on stream:domain-events: turns seat
 * state changes (reservation.created/cancelled/expired, order.paid,
 * order.refunded) into Pub/Sub messages on each event's live channel, so
 * every open seat map updates without polling (docs/pubsub.md).
 */
export const LIVE_SEAT_CONSUMER_GROUP = 'live-seats';
