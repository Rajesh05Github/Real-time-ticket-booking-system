import { prisma } from '@flashsale/database';

import type { FastifyInstance } from 'fastify';

/**
 * /health and /ready are deliberately DIFFERENT checks (section 36):
 *
 * - /health = "is the process alive" (liveness). Used by an orchestrator to
 *   decide whether to KILL and restart the container. Must never depend on
 *   Postgres/Redis -- if it did, a database blip would cause a restart
 *   storm across every instance simultaneously, which is worse than the
 *   original outage.
 *
 * - /ready = "can this instance serve traffic right now" (readiness). Used
 *   by a load balancer to decide whether to ROUTE traffic to this instance.
 *   This one DOES check Postgres/Redis, because an instance that can't
 *   reach either should be pulled from rotation, not killed.
 */

const CHECK_TIMEOUT_MS = 2000;

/** A hung dependency must fail the check, not hang the probe itself. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // Promise.race does NOT attach a rejection handler to the promise that
  // loses the race -- if `promise` settles (rejects) after the timeout
  // has already won, that rejection is otherwise completely unobserved.
  // Node treats an unobserved rejection as fatal (crashes the process),
  // which would mean a slow, eventually-erroring Postgres/Redis call
  // could crash the very health check meant to detect it being unhealthy.
  // This no-op catch guarantees SOMETHING always observes it.
  promise.catch(() => {});

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function checkDatabase(): Promise<'ok' | 'error'> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'error';
  }
}

export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', () => {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  });

  app.get('/ready', async (_request, reply) => {
    const [database, redis] = await Promise.all([
      checkDatabase(),
      withTimeout(app.redis.ping(), CHECK_TIMEOUT_MS)
        .then(() => 'ok' as const)
        .catch(() => 'error' as const),
    ]);

    const allOk = database === 'ok' && redis === 'ok';
    // A degraded dependency means this instance should be pulled from
    // load-balancer rotation -- 503, not 200-with-a-note-buried-in-the-body,
    // so an Nginx/ALB health check configured to look at status codes
    // alone still does the right thing.
    reply.status(allOk ? 200 : 503);
    return { status: allOk ? 'ok' : 'degraded', checks: { database, redis } };
  });
}
