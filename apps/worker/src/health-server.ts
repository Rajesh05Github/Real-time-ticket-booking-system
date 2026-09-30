import { createServer, type Server } from 'node:http';

import type { Logger } from '@flashsale/logger';

export interface HealthServer {
  stop: () => Promise<void>;
}

/**
 * A LIVENESS-only health endpoint -- deliberately not a `/ready` that
 * pings Postgres/Redis the way apps/api's does (health.routes.ts). This
 * worker has no request path a dependency outage should take out of
 * rotation; Phase 19's failure testing already confirmed a Postgres or
 * Redis outage degrades this process gracefully (log-and-retry each
 * tick) rather than crashing it, so "is the process alive and responding
 * to HTTP at all" is the one question worth answering here. If a real
 * readiness signal (e.g. "stop routing new work to me, my queue
 * connections are unhealthy") becomes useful, it belongs alongside this,
 * not as a replacement for it.
 *
 * A plain `node:http` server, not Fastify -- this worker has no other
 * HTTP surface and pulling in a whole framework for one static-response
 * endpoint would be a real dependency for no real benefit.
 */
export function startHealthServer(port: number, logger: Logger): HealthServer {
  const server: Server = createServer((request, response) => {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404).end();
  });

  // Explicit '0.0.0.0', not the default -- apps/api's own app.ts hit
  // this exact gotcha (see docker-compose.yml's api healthcheck
  // comment): Alpine/musl's wget resolves `localhost`/an unspecified
  // bind to `::1` first, and a server that only ended up bound to IPv6
  // would fail every healthcheck against a server that's actually up.
  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'worker health server listening');
  });

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
