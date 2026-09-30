import { prisma } from '@flashsale/database';
import { createLogger } from '@flashsale/logger';
import { createRedisClient } from '@flashsale/redis';

import { startAnalyticsConsumer } from './consumers/analytics-consumer.js';
import { startDomainEventConsumer } from './consumers/domain-event-consumer.js';
import { startLiveSeatConsumer } from './consumers/live-seat-consumer.js';
import { env } from './env.js';
import { startHealthServer } from './health-server.js';
import { startIdempotencyKeyCleanup } from './jobs/idempotency-key-cleanup.js';
import { startOutboxPublisher } from './jobs/outbox-publisher.js';
import { startRefundProcessor } from './jobs/refund-processor.js';
import { startReservationExpirySweeper } from './jobs/reservation-expiry-sweep.js';
import { AcsEmailProvider } from './providers/acs-email-provider.js';
import { ConsoleEmailProvider } from './providers/console-email-provider.js';
import { MockRefundProvider, RefundProviderRegistry } from './providers/refund-provider.js';
import { SmtpEmailProvider } from './providers/smtp-email-provider.js';
import { registerShutdownHooks } from './register-shutdown-hooks.js';
import { onShutdown, registerGracefulShutdown } from './shutdown.js';
import { startEmailWorker } from './workers/email-worker.js';
import { startReservationExpiryWorker } from './workers/reservation-expiry-worker.js';
import { startSeatGenerationWorker } from './workers/seat-generation-worker.js';

import type { EmailProvider } from './providers/email-provider.js';

const logger = createLogger({
  service: 'worker',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

registerGracefulShutdown(logger, env.SHUTDOWN_TIMEOUT_MS);

const healthServer = startHealthServer(env.WORKER_PORT, logger);

// Selected by EMAIL_PROVIDER (env.ts validates that each provider's
// required settings are present before we ever get here).
function createEmailProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'smtp':
      return new SmtpEmailProvider({
        host: env.SMTP_HOST ?? '',
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.EMAIL_FROM ?? '',
      });
    case 'acs':
      return new AcsEmailProvider(env.ACS_EMAIL_CONNECTION_STRING ?? '', env.EMAIL_FROM ?? '');
    case 'console':
      if (env.NODE_ENV === 'production') {
        logger.warn(
          'EMAIL_PROVIDER=console in production -- verification emails are only logged, never delivered. ' +
            'Set EMAIL_PROVIDER=smtp or acs for a real deployment.',
        );
      }
      return new ConsoleEmailProvider(logger);
  }
}

const emailProvider = createEmailProvider();
logger.info({ emailProvider: env.EMAIL_PROVIDER }, 'email provider configured');
const emailWorker = startEmailWorker(env.REDIS_URL, emailProvider, logger, env.WORKER_CONCURRENCY);
const seatGenerationWorker = startSeatGenerationWorker(env.REDIS_URL, logger, env.WORKER_CONCURRENCY);
const reservationExpiryWorker = startReservationExpiryWorker(env.REDIS_URL, logger, env.WORKER_CONCURRENCY);
const reservationSweeper = startReservationExpirySweeper(logger);

// A plain general-purpose client (createRedisClient), NOT
// createBullMQConnection -- XADD is an ordinary command with no need for
// BullMQ's `maxRetriesPerRequest: null` / `enableReadyCheck: false`
// blocking-read tuning (packages/redis/src/client.ts's comment on why
// those two client configs are never interchangeable).
const outboxRedis = createRedisClient(env.REDIS_URL);
const outboxPublisher = startOutboxPublisher(outboxRedis, logger);

// A SEPARATE connection from outboxRedis, deliberately -- XREADGROUP's
// BLOCK option occupies whichever connection issues it for up to
// STREAM_CONSUMER_BLOCK_MS at a time. Sharing a client between this and
// the outbox publisher would queue the publisher's own XADD calls behind
// every blocking read, stalling publishing by up to that same interval.
const consumerRedis = createRedisClient(env.REDIS_URL);
const domainEventConsumer = startDomainEventConsumer(consumerRedis, logger);

// A THIRD connection, same reasoning as consumerRedis above: this
// group's own blocking XREADGROUP would otherwise queue behind (or be
// queued behind by) the notifications group's blocking reads if they
// shared one client.
const analyticsRedis = createRedisClient(env.REDIS_URL);
const analyticsConsumer = startAnalyticsConsumer(analyticsRedis, logger);

// A FOURTH connection for the third consumer group (live seat-map
// updates) -- same one-blocking-reader-per-connection rule. PUBLISH on
// this same connection is fine: it's issued between blocking reads, never
// concurrently with one.
const liveSeatRedis = createRedisClient(env.REDIS_URL);
const liveSeatConsumer = startLiveSeatConsumer(liveSeatRedis, logger);

// Refunds go back through the gateway that took the payment
// (Payment.provider). 'mock' pairs with apps/api's MockPaymentProvider;
// a real gateway registers its RefundProvider here alongside it.
const refundProcessor = startRefundProcessor(
  new RefundProviderRegistry({ mock: new MockRefundProvider() }),
  logger,
);
const idempotencyKeyCleanup = startIdempotencyKeyCleanup(logger);

// The ORDER these nine close in (Prisma last, after everything else) is
// a deliberate, previously-buggy-in-practice contract -- see
// register-shutdown-hooks.ts's comment and its regression test for the
// full story of why this isn't just seven arbitrary onShutdown() calls.
registerShutdownHooks(
  onShutdown,
  {
    disconnectPrisma: () => prisma.$disconnect(),
    closeEmailWorker: () => emailWorker.close(),
    closeSeatGenerationWorker: () => seatGenerationWorker.close(),
    closeReservationExpiryWorker: () => reservationExpiryWorker.close(),
    stopReservationSweeper: () => reservationSweeper.stop(),
    stopOutboxPublisher: async () => {
      await outboxPublisher.stop();
      outboxRedis.disconnect();
    },
    stopDomainEventConsumer: async () => {
      await domainEventConsumer.stop();
      consumerRedis.disconnect();
    },
    stopAnalyticsConsumer: async () => {
      await analyticsConsumer.stop();
      analyticsRedis.disconnect();
    },
    stopLiveSeatConsumer: async () => {
      await liveSeatConsumer.stop();
      liveSeatRedis.disconnect();
    },
    stopRefundProcessor: () => refundProcessor.stop(),
    stopIdempotencyKeyCleanup: () => idempotencyKeyCleanup.stop(),
    stopHealthServer: () => healthServer.stop(),
  },
  logger,
);

logger.info(
  { concurrency: env.WORKER_CONCURRENCY, nodeEnv: env.NODE_ENV },
  'worker process started',
);

// Keep the process alive even though the BullMQ Worker's own Redis
// connection already does this in practice -- explicit and cheap
// insurance against a future refactor accidentally removing the last
// thing holding the event loop open.
setInterval(() => {
  logger.debug('worker heartbeat');
}, 30_000);
