import type { ShutdownHandler } from './shutdown.js';
import type { Logger } from '@flashsale/logger';


export interface ShutdownDeps {
  disconnectPrisma: () => Promise<void>;
  closeEmailWorker: () => Promise<void>;
  closeSeatGenerationWorker: () => Promise<void>;
  closeReservationExpiryWorker: () => Promise<void>;
  stopReservationSweeper: () => Promise<void>;
  stopOutboxPublisher: () => Promise<void>;
  stopDomainEventConsumer: () => Promise<void>;
  stopAnalyticsConsumer: () => Promise<void>;
  stopLiveSeatConsumer: () => Promise<void>;
  stopRefundProcessor: () => Promise<void>;
  stopIdempotencyKeyCleanup: () => Promise<void>;
  stopHealthServer: () => Promise<void>;
}

/**
 * The specific hook REGISTRATION ORDER that was wrong in Phase 5, found
 * live: `onShutdown` handlers run in reverse registration order
 * (shutdown.ts's `runShutdownHandlers`), so whichever resource is
 * registered FIRST closes LAST.
 *
 * Prisma is registered first here so it closes LAST -- both BullMQ
 * workers may still be mid-job when SIGTERM arrives, and a job's final
 * step (recordAuditLog, updating a Notification's status) needs a live
 * Prisma connection to complete. Registering Prisma's disconnect last
 * (closing it first) -- the original bug -- would disconnect it while a
 * job still mid-close might try to use it.
 *
 * Extracted into its own function specifically so this ordering is
 * independently testable (register-shutdown-hooks.test.ts) without
 * starting real BullMQ workers or a real Prisma connection -- the test
 * passes fake `deps` and asserts the OBSERVED close order, not just that
 * three functions got called.
 */
export function registerShutdownHooks(
  onShutdown: (handler: ShutdownHandler) => void,
  deps: ShutdownDeps,
  logger: Logger,
): void {
  onShutdown(async () => {
    await deps.disconnectPrisma();
    logger.info('prisma disconnected');
  });

  onShutdown(async () => {
    // BullMQ's own close() waits for in-flight jobs to finish (up to its
    // internal grace period) before releasing its Redis connection --
    // this is what prevents a mid-send email job from being abandoned
    // half-delivered when the container receives SIGTERM.
    await deps.closeEmailWorker();
    logger.info('email worker closed');
  });

  onShutdown(async () => {
    // Same reasoning as the email worker above -- a bulk seat-generation
    // job that's mid-chunk when SIGTERM arrives gets to finish that
    // chunk (and record its progress) rather than being torn down
    // mid-insert.
    await deps.closeSeatGenerationWorker();
    logger.info('seat generation worker closed');
  });

  onShutdown(async () => {
    // Same reasoning as the two BullMQ workers above -- an in-flight
    // expire-reservation job (Phase 12) finishes its call to
    // releaseReservation before this worker's connection closes.
    await deps.closeReservationExpiryWorker();
    logger.info('reservation expiry worker closed');
  });

  onShutdown(async () => {
    // Same class of bug this whole ordering exists to prevent, applied to
    // a plain setInterval instead of a BullMQ worker: if a sweep tick is
    // mid-releaseReservation (a live Prisma call) when this runs,
    // stopReservationSweeper's own `await currentTick` (see
    // reservation-expiry-sweep.ts) is what keeps Prisma from disconnecting
    // out from under it.
    await deps.stopReservationSweeper();
    logger.info('reservation expiry sweeper stopped');
  });

  onShutdown(async () => {
    // Same reasoning again: stopOutboxPublisher awaits its own in-flight
    // tick (and only then disconnects its Redis client) before this
    // resolves, so a publish tick mid-Prisma-write can't be cut off by
    // Prisma disconnecting underneath it.
    await deps.stopOutboxPublisher();
    logger.info('outbox publisher stopped');
  });

  onShutdown(async () => {
    // stopDomainEventConsumer's own `await runPromise` (see
    // domain-event-consumer.ts) waits out the current XREADGROUP BLOCK
    // call (up to STREAM_CONSUMER_BLOCK_MS) and any message it's mid-
    // processing before this resolves, same reasoning as every hook
    // above.
    await deps.stopDomainEventConsumer();
    logger.info('domain event consumer stopped');
  });

  onShutdown(async () => {
    // Same reasoning as stopDomainEventConsumer above -- this is the
    // OTHER consumer group reading stream:domain-events (Phase 16),
    // independent Pending Entries List, independent shutdown wait.
    await deps.stopAnalyticsConsumer();
    logger.info('analytics consumer stopped');
  });

  onShutdown(async () => {
    // Third consumer group on the same stream -- same wait-out-the-BLOCK
    // reasoning as the two above.
    await deps.stopLiveSeatConsumer();
    logger.info('live seat consumer stopped');
  });

  onShutdown(async () => {
    // A refund tick may be between "provider accepted the refund" and
    // "recorded REFUNDED in Postgres"; awaiting it here keeps Prisma alive
    // for that final write (a cut-off tick would still be safe -- the
    // retry is idempotent -- but finishing cleanly avoids the retry).
    await deps.stopRefundProcessor();
    logger.info('refund processor stopped');
  });

  onShutdown(async () => {
    await deps.stopIdempotencyKeyCleanup();
    logger.info('idempotency key cleanup stopped');
  });

  onShutdown(async () => {
    // Registered LAST -- closes FIRST, same "signal I'm going away as
    // early as possible" reasoning as every hook above, made most
    // literal here: this is the one resource an external health check
    // actually polls, so failing it immediately (rather than after every
    // other resource has drained) is the correct signal for any
    // orchestrator watching it, even though nothing in THIS project's
    // docker-compose.yml currently reacts to that signal itself (Phase
    // 21's AWS deployment target-group health checks would).
    await deps.stopHealthServer();
    logger.info('health server stopped');
  });
}
