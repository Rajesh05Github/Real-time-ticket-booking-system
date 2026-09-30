import { describe, expect, it, vi } from 'vitest';

import { registerShutdownHooks } from './register-shutdown-hooks.js';
import { runShutdownHandlers, type ShutdownHandler } from './shutdown.js';

import type { Logger } from '@flashsale/logger';

const silentLogger = {
  info: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger;

describe('registerShutdownHooks', () => {
  it('closes Prisma AFTER both BullMQ workers have finished closing', async () => {
    // This is a direct regression test for the Phase 5 bug: an earlier
    // version registered Prisma's disconnect LAST (intending "close
    // everything, then disconnect Prisma last"), but because
    // runShutdownHandlers executes in REVERSE registration order, that
    // actually disconnected Prisma FIRST -- before either worker had a
    // chance to finish an in-flight job's final database write (e.g.
    // recordAuditLog). It went unnoticed in manual testing because
    // nothing happened to be mid-job at the moment SIGTERM was sent; a
    // live Docker shutdown log is what surfaced the wrong order.
    //
    // Registering fake, ARTIFICIALLY SLOW closers (each records both a
    // start and end event) is what makes this test actually meaningful
    // rather than just checking "called once": if Prisma's disconnect
    // fired while a worker's close() was still in-flight, that worker's
    // OWN 'end' event would appear after 'prisma disconnected' in the
    // trace, which the assertion below would catch.
    const order: string[] = [];
    const registered: ShutdownHandler[] = [];
    const onShutdown = (handler: ShutdownHandler): void => {
      registered.push(handler);
    };

    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    registerShutdownHooks(
      onShutdown,
      {
        disconnectPrisma: async () => {
          order.push('prisma:start');
          order.push('prisma:end');
        },
        closeEmailWorker: async () => {
          order.push('email:start');
          await delay(10); // simulates an in-flight job finishing
          order.push('email:end');
        },
        closeSeatGenerationWorker: async () => {
          order.push('seatGeneration:start');
          await delay(10);
          order.push('seatGeneration:end');
        },
        closeReservationExpiryWorker: async () => {
          order.push('reservationExpiryWorker:start');
          await delay(10);
          order.push('reservationExpiryWorker:end');
        },
        stopReservationSweeper: async () => {
          order.push('sweeper:start');
          await delay(10);
          order.push('sweeper:end');
        },
        stopOutboxPublisher: async () => {
          order.push('outbox:start');
          await delay(10);
          order.push('outbox:end');
        },
        stopDomainEventConsumer: async () => {
          order.push('consumer:start');
          await delay(10);
          order.push('consumer:end');
        },
        stopAnalyticsConsumer: async () => {
          order.push('analytics:start');
          await delay(10);
          order.push('analytics:end');
        },
        stopLiveSeatConsumer: async () => {
          order.push('liveSeats:start');
          await delay(10);
          order.push('liveSeats:end');
        },
        stopRefundProcessor: async () => {
          order.push('refunds:start');
          await delay(10);
          order.push('refunds:end');
        },
        stopIdempotencyKeyCleanup: async () => {
          order.push('idemCleanup:start');
          await delay(10);
          order.push('idemCleanup:end');
        },
        stopHealthServer: async () => {
          order.push('health:start');
          await delay(10);
          order.push('health:end');
        },
      },
      silentLogger,
    );

    await runShutdownHandlers(registered);

    const prismaIndex = order.indexOf('prisma:start');
    const emailEndIndex = order.indexOf('email:end');
    const seatGenerationEndIndex = order.indexOf('seatGeneration:end');
    const reservationExpiryWorkerEndIndex = order.indexOf('reservationExpiryWorker:end');
    const sweeperEndIndex = order.indexOf('sweeper:end');
    const outboxEndIndex = order.indexOf('outbox:end');
    const consumerEndIndex = order.indexOf('consumer:end');
    const analyticsEndIndex = order.indexOf('analytics:end');
    const healthEndIndex = order.indexOf('health:end');

    // The property that actually matters: Prisma never starts
    // disconnecting until every other resource has fully finished closing
    // -- not merely "was registered before/after" but "ran after."
    expect(prismaIndex).toBeGreaterThan(emailEndIndex);
    expect(prismaIndex).toBeGreaterThan(seatGenerationEndIndex);
    expect(prismaIndex).toBeGreaterThan(reservationExpiryWorkerEndIndex);
    expect(prismaIndex).toBeGreaterThan(sweeperEndIndex);
    expect(prismaIndex).toBeGreaterThan(outboxEndIndex);
    expect(prismaIndex).toBeGreaterThan(consumerEndIndex);
    expect(prismaIndex).toBeGreaterThan(analyticsEndIndex);
    expect(prismaIndex).toBeGreaterThan(order.indexOf('liveSeats:end'));
    expect(prismaIndex).toBeGreaterThan(order.indexOf('refunds:end'));
    expect(prismaIndex).toBeGreaterThan(order.indexOf('idemCleanup:end'));
    expect(prismaIndex).toBeGreaterThan(healthEndIndex);
  });

  it('logs each resource by name after it closes', async () => {
    const registered: ShutdownHandler[] = [];
    const onShutdown = (handler: ShutdownHandler): void => {
      registered.push(handler);
    };

    registerShutdownHooks(
      onShutdown,
      {
        disconnectPrisma: vi.fn().mockResolvedValue(undefined),
        closeEmailWorker: vi.fn().mockResolvedValue(undefined),
        closeSeatGenerationWorker: vi.fn().mockResolvedValue(undefined),
        closeReservationExpiryWorker: vi.fn().mockResolvedValue(undefined),
        stopReservationSweeper: vi.fn().mockResolvedValue(undefined),
        stopOutboxPublisher: vi.fn().mockResolvedValue(undefined),
        stopDomainEventConsumer: vi.fn().mockResolvedValue(undefined),
        stopAnalyticsConsumer: vi.fn().mockResolvedValue(undefined),
        stopLiveSeatConsumer: vi.fn().mockResolvedValue(undefined),
        stopRefundProcessor: vi.fn().mockResolvedValue(undefined),
        stopIdempotencyKeyCleanup: vi.fn().mockResolvedValue(undefined),
        stopHealthServer: vi.fn().mockResolvedValue(undefined),
      },
      silentLogger,
    );

    await runShutdownHandlers(registered);

    expect(silentLogger.info).toHaveBeenCalledWith('prisma disconnected');
    expect(silentLogger.info).toHaveBeenCalledWith('email worker closed');
    expect(silentLogger.info).toHaveBeenCalledWith('seat generation worker closed');
    expect(silentLogger.info).toHaveBeenCalledWith('reservation expiry worker closed');
    expect(silentLogger.info).toHaveBeenCalledWith('reservation expiry sweeper stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('outbox publisher stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('domain event consumer stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('analytics consumer stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('live seat consumer stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('refund processor stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('idempotency key cleanup stopped');
    expect(silentLogger.info).toHaveBeenCalledWith('health server stopped');
  });
});
