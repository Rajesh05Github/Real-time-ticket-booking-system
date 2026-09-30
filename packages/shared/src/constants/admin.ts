/**
 * Above this many seats in a single generation request, seat creation
 * moves from "inline, inside the request's own transaction" to "enqueued
 * as a background job" (QUEUE_NAMES.SEAT_GENERATION).
 *
 * Why this exists at all (Phase 0 correction): a real stadium can have
 * tens of thousands of seats. Creating them all inside one HTTP
 * request's transaction risks the client timing out long before the
 * `INSERT`s finish, and holds a single database transaction open for
 * that whole duration -- exactly the kind of long-running transaction
 * that blocks vacuum and holds locks on the seats table for other admins
 * working concurrently.
 *
 * 200 is deliberately generous for typical local-dev/demo venues (the
 * seed data's 40 seats, a small venue's few hundred) while still forcing
 * genuinely large requests onto the job path where they belong.
 */
export const SEAT_GENERATION_SYNC_LIMIT = 200;

/** Seats are inserted in chunks of this size within the background job,
 * so `job.updateProgress()` can report meaningful incremental progress
 * and no single `createMany` call has to hold tens of thousands of rows
 * in memory at once. */
export const SEAT_GENERATION_CHUNK_SIZE = 500;
