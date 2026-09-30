import type { Logger } from '@flashsale/logger';

/**
 * Worker graceful shutdown is a DIFFERENT problem from the API's.
 *
 * The API drains HTTP connections. The worker must stop PULLING NEW jobs
 * but let its currently-executing job(s) finish -- killing a worker
 * mid-job is how you get a reservation stuck in a half-updated state, or a
 * BullMQ job marked "active" forever (until its stalled-job timeout
 * recovers it, which is itself a failure mode worth knowing about, not
 * relying on).
 *
 * Phase 11/12 register real cleanup callbacks here (BullMQ Worker.close(),
 * Redis Stream consumer loop stop signal) via `onShutdown`. This module
 * only owns the SIGNAL HANDLING and ORDERING contract so every future
 * queue/consumer plugs into the same lifecycle instead of each one
 * reinventing its own signal handler.
 */
export type ShutdownHandler = () => Promise<void>;

const handlers: ShutdownHandler[] = [];

export function onShutdown(handler: ShutdownHandler): void {
  handlers.push(handler);
}

/**
 * Extracted as its own pure function specifically so this ORDERING
 * CONTRACT is directly testable (shutdown.test.ts) without touching
 * `registerGracefulShutdown`'s process.exit()/signal-handling side
 * effects, and without depending on the module-level `handlers` array
 * (which accumulates across a whole test run and can't be reset between
 * test cases). Reverse order means "last-registered = last-started
 * resource shuts down first" -- register foundational resources (a
 * database connection) FIRST so they close LAST, after anything that
 * still needs them during its own shutdown has finished (see
 * apps/worker/src/register-shutdown-hooks.ts for exactly this mistake,
 * found live in Phase 5, and its regression test).
 */
export async function runShutdownHandlers(handlersToRun: ShutdownHandler[]): Promise<void> {
  for (const handler of [...handlersToRun].reverse()) {
    await handler();
  }
}

export function registerGracefulShutdown(logger: Logger, timeoutMs: number): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal, handlerCount: handlers.length }, 'worker received shutdown signal');

    const forceExitTimer = setTimeout(() => {
      logger.error({ timeoutMs }, 'worker graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    forceExitTimer.unref();

    try {
      await runShutdownHandlers(handlers);
      logger.info('worker shutdown complete');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during worker shutdown');
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'worker uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'worker unhandled promise rejection');
    process.exit(1);
  });
}
