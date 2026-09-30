import { PrismaClient } from '@prisma/client';

/**
 * Module-scoped singleton, not "new PrismaClient() wherever it's needed".
 *
 * Each PrismaClient instance owns its own connection pool. Every extra
 * instance is an extra pool competing for Postgres's limited
 * max_connections (docs/database.md covers the actual per-instance pool
 * math) -- this is one of the concrete ways an application can exhaust
 * connections without ever running many processes.
 *
 * Both apps/api and apps/worker run under `tsx watch`, which restarts the
 * whole Node process on file change (unlike Next.js's dev server, which
 * can hot-reload modules within one long-lived process) -- so the classic
 * "globalThis" workaround for surviving hot-reload isn't strictly needed
 * here. It's omitted deliberately rather than copy-pasted from a
 * Next.js-specific pattern that doesn't apply to this process model.
 */
export const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === 'development'
      ? [
          { emit: 'stdout', level: 'error' },
          { emit: 'stdout', level: 'warn' },
        ]
      : [{ emit: 'stdout', level: 'error' }],
});
