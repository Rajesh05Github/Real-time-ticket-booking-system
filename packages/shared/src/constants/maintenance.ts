/**
 * apps/worker housekeeping constants.
 */

/**
 * How long a COMPLETED idempotency_keys row is kept. A client retrying
 * the same Idempotency-Key after this gets a fresh execution instead of a
 * replay -- 24h is far beyond any realistic retry window (browser
 * double-clicks, network retries, a user coming back to a tab).
 */
export const IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * An IN_PROGRESS row older than this belongs to a request whose process
 * died before onResponse could complete or delete it. Left alone it
 * would answer every retry of that key with REQUEST_IN_PROGRESS forever;
 * deleting it lets the retry actually run.
 */
export const IDEMPOTENCY_KEY_STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

/** How often the cleanup job runs. */
export const IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
