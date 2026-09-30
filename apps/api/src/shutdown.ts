import type { FastifyInstance } from 'fastify';

/**
 * Section 37 graceful shutdown.
 *
 * The sequence matters and is easy to get subtly wrong:
 *
 *   1. Stop accepting NEW connections/requests (app.close() does this --
 *      Fastify stops the listener immediately but lets in-flight requests
 *      finish).
 *   2. Wait for in-flight requests to drain, up to a timeout.
 *   3. Close downstream resources in dependency order: nothing should try
 *      to use Redis/Postgres AFTER they're closed, so app.close() (which
 *      runs Fastify's onClose hooks) must complete before we close the
 *      raw clients.
 *   4. Exit.
 *
 * Why this matters concretely: without it, a rolling deploy or autoscaling
 * scale-down sends SIGTERM, Kubernetes/ECS gives the container a grace
 * period (default 30s), and if the process just dies immediately every
 * in-flight reservation request gets an abrupt connection reset instead of
 * a clean response -- which, for a payment or reservation request, is
 * exactly the ambiguous "did it work or not" state section 22 (idempotency)
 * exists to protect against. Idempotency and graceful shutdown are two
 * layers of the same problem: don't let "the process stopped mid-request"
 * corrupt state or confuse the client.
 *
 * A hard timeout is still necessary: a client that never completes its
 * request (slow network, dead connection) would otherwise block shutdown
 * forever. SHUTDOWN_TIMEOUT_MS bounds the wait and forces an exit.
 */
export function registerGracefulShutdown(app: FastifyInstance, timeoutMs: number): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return; // ignore a second SIGTERM while already draining
    shuttingDown = true;

    app.log.info({ signal }, 'received shutdown signal, draining connections');

    const forceExitTimer = setTimeout(() => {
      app.log.error({ timeoutMs }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    forceExitTimer.unref();

    try {
      // app.close() stops the listener and runs registered onClose hooks
      // (this is where Redis/Postgres client .disconnect() calls will be
      // registered in Phase 2/3, via app.addHook('onClose', ...)) in
      // reverse registration order, awaiting in-flight requests first.
      await app.close();
      app.log.info('shutdown complete');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A truly unexpected error should not leave the process in a half-alive
  // state either. Log with full detail and exit non-zero so the
  // orchestrator restarts a clean instance rather than a corrupted one.
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
}
