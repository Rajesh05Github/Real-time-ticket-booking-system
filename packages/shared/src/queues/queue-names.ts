/**
 * Queue and job name constants, shared between producer (apps/api, which
 * calls Queue.add()) and consumer (apps/worker, which runs a Worker) so
 * neither side can drift from the other on a typo'd string literal.
 *
 * `emailQueue` (Phase 4) and `seatGenerationQueue` (Phase 5) exist for
 * what registration's OTP delivery and bulk seat creation each need.
 * Phase 12 adds ONE more: `reservationExpiryQueue`, the delayed-job
 * complement Phase 9's sweeper comment promised.
 *
 * This corrects an earlier plan: Phase 4's original comment here said
 * Phase 12 would ALSO add `notificationQueue`, `paymentQueue`, and
 * `analyticsQueue`. It doesn't, on purpose. `notificationQueue` turned
 * out to be unnecessary -- Phase 11 solved fan-out via a Redis Streams
 * consumer group reading the outbox, a better fit than a queue for
 * "deliver this to whichever users care" than BullMQ's one-consumer-per-
 * job model. `paymentQueue` and `analyticsQueue` have no real job to
 * define yet -- their job payload shapes depend on decisions Phases 13
 * and 16 haven't made. Declaring queue names with no producer or
 * consumer behind them would be exactly the "not yet needed" complexity
 * section 58 warns against; they'll be added here, following this same
 * pattern, when those phases actually need them.
 */
export const QUEUE_NAMES = {
  EMAIL: 'emailQueue',
  // Phase 5: a large seat-generation request (e.g. a real stadium with
  // tens of thousands of seats) cannot run inside a single request-scoped
  // Postgres transaction without risking a client timeout -- see
  // SEAT_GENERATION_SYNC_LIMIT below for the threshold that decides
  // whether a request is handled inline or here instead.
  SEAT_GENERATION: 'seatGenerationQueue',
  // Phase 12: the delayed-job half of reservation expiry, racing the
  // Postgres sweeper (apps/worker/src/jobs/reservation-expiry-sweep.ts,
  // Phase 9) for near-instant expiry instead of waiting up to
  // RESERVATION_SWEEP_INTERVAL_MS. See docs/queues.md.
  RESERVATION_EXPIRY: 'reservationExpiryQueue',
} as const;

export const JOB_NAMES = {
  SEND_OTP_EMAIL: 'send-otp-email',
  GENERATE_SEATS: 'generate-seats',
  EXPIRE_RESERVATION: 'expire-reservation',
} as const;

/**
 * Retry/backoff policy, per queue (Phase 12's "documentation pass" the
 * old comment promised). Every number here is a DELIBERATE choice, not a
 * BullMQ default left unexamined -- BullMQ's own actual default is
 * `attempts: 1` (no retry at all), which is what every queue in this
 * codebase silently ran on until this phase. `removeOnFail`, bounded
 * rather than left at BullMQ's "keep forever" default, doubles as this
 * project's dead-letter mechanism: the failed set IS the DLQ, inspectable
 * via `queue.getFailed()`, with no separate hand-rolled DLQ queue needed
 * (section 58) -- see docs/queues.md.
 */
export const QUEUE_JOB_RETENTION_COUNT = 1000;

export const EMAIL_JOB_MAX_ATTEMPTS = 5;
export const EMAIL_JOB_BACKOFF_DELAY_MS = 5_000;

export const SEAT_GENERATION_JOB_MAX_ATTEMPTS = 3;
export const SEAT_GENERATION_JOB_BACKOFF_DELAY_MS = 10_000;

export const RESERVATION_EXPIRY_JOB_MAX_ATTEMPTS = 3;
export const RESERVATION_EXPIRY_JOB_BACKOFF_DELAY_MS = 5_000;

/**
 * The OTP itself travels in the job payload, not just a reference to it --
 * this is the same trust boundary as the Redis otp:user:{userId} key it's
 * generated alongside (both are transient, both exist only long enough to
 * deliver one email), so duplicating it here isn't a new exposure. The
 * job does NOT carry the notification's full content/template -- that's
 * assembled by the email provider from `type`, keeping the queue payload
 * a small, stable contract even as email templates change later.
 */
export interface SendOtpEmailJobData {
  notificationId: string;
  userId: string;
  email: string;
  otp: string;
}

/**
 * One "section assignment" generates `seatCount` seats named
 * `${seatCodePrefix}${startNumber}` .. `${seatCodePrefix}${startNumber + seatCount - 1}`,
 * all priced identically. Multiple assignments in one job let an admin
 * generate a whole venue's seating (different price per section) in a
 * single request/job rather than one call per section.
 */
export interface SeatGenerationAssignment {
  sectionId: string;
  seatCodePrefix: string;
  startNumber: number;
  seatCount: number;
  priceMinor: number;
  currency: string;
}

export interface GenerateSeatsJobData {
  eventId: string;
  actorId: string;
  assignments: SeatGenerationAssignment[];
}

/**
 * Deliberately just the id -- everything else the worker needs
 * (`releaseReservation`'s own `WHERE status = 'RESERVED'` guard,
 * packages/database) is re-read from Postgres at process time, not
 * carried in the job payload. Unlike SendOtpEmailJobData's OTP (which
 * MUST travel with the job since Redis's otp:user:{userId} key could
 * expire before the job runs), a reservation's current status can only
 * be answered correctly by reading it fresh -- carrying a stale
 * snapshot here would risk expiring a reservation the user already paid
 * for in the ~10 minutes between enqueue and this job firing.
 */
export interface ExpireReservationJobData {
  reservationId: string;
}
