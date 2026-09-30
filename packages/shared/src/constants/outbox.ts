/**
 * Transactional outbox constants (Phase 10, section 8). Shared between
 * apps/worker's publisher (the only current reader/writer of most of
 * these) and anywhere else that needs to reason about outbox timing.
 */

/** How often apps/worker's outbox publisher polls for PENDING rows. */
export const OUTBOX_PUBLISH_INTERVAL_MS = 5_000;

/** Caps how many PENDING rows one publish tick processes -- same
 * "leftover work picked up by the next tick" reasoning as
 * RESERVATION_SWEEP_BATCH_SIZE, applied to publishing instead of expiry. */
export const OUTBOX_PUBLISH_BATCH_SIZE = 100;

/**
 * After this many failed XADD attempts for the SAME row, the publisher
 * stops retrying it and marks it FAILED instead of PENDING -- an
 * unpublishable event (Redis has been down for a while, or something is
 * structurally wrong with this specific row) should surface as something
 * an operator investigates, not retry forever indistinguishably from a
 * healthy backlog.
 */
export const OUTBOX_MAX_PUBLISH_ATTEMPTS = 10;

/**
 * Approximate (`~`) MAXLEN trimming applied on every XADD to
 * stream:domain-events. Approximate, not exact: Redis can trim exact
 * MAXLEN in O(N) per command (it has to find and remove precisely the
 * Nth-oldest entry), while `~` lets it trim lazily in whichever internal
 * radix-tree node it's already touching -- the stream may briefly hold
 * somewhat more than this many entries, which is an entirely acceptable
 * trade for O(1) trimming on a hot write path. Bounding stream length at
 * all matters because nothing consumes this stream yet in Phase 10 --
 * without a cap, it would grow unboundedly until Phase 11's consumers
 * exist.
 */
export const DOMAIN_EVENTS_STREAM_MAXLEN = 10_000;
