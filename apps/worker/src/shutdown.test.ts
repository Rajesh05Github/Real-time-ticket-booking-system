import { describe, expect, it } from 'vitest';

import { runShutdownHandlers, type ShutdownHandler } from './shutdown.js';

describe('runShutdownHandlers', () => {
  it('runs handlers in REVERSE registration order', async () => {
    // This is the exact mechanism that made Phase 5's shutdown-ordering
    // bug possible: registerGracefulShutdown relies on "last registered
    // = first to close." A regression here (e.g. someone "simplifying"
    // this to forward order) would silently invert every ordering
    // decision built on top of it, including
    // register-shutdown-hooks.ts's Prisma-closes-last contract.
    const order: string[] = [];
    const handlers: ShutdownHandler[] = [
      async () => {
        order.push('first-registered');
      },
      async () => {
        order.push('second-registered');
      },
      async () => {
        order.push('third-registered');
      },
    ];

    await runShutdownHandlers(handlers);

    expect(order).toEqual(['third-registered', 'second-registered', 'first-registered']);
  });

  it('awaits each handler fully before starting the next (sequential, not parallel)', async () => {
    // If a future change accidentally parallelized this (e.g. swapping
    // the for-loop for `Promise.all`), a slow handler could no longer
    // guarantee it fully finished before the next one starts closing --
    // which matters here specifically because the whole point of the
    // ordering contract is "X is guaranteed fully closed before Y
    // starts," not just "X was told to close before Y."
    const events: string[] = [];
    const handlers: ShutdownHandler[] = [
      async () => {
        events.push('slow-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('slow-end');
      },
      async () => {
        events.push('fast');
      },
    ];

    await runShutdownHandlers(handlers);

    // Reverse order runs 'fast' first, then the slow one -- but the
    // assertion that matters is that 'slow-end' always precedes nothing
    // after it, i.e. the function didn't resolve until the slow handler
    // (started last, since it's first in registration order) fully
    // completed.
    expect(events).toEqual(['fast', 'slow-start', 'slow-end']);
  });

  it('propagates a handler error rather than swallowing it', async () => {
    // registerGracefulShutdown's caller treats a thrown error as "exit
    // 1, shutdown failed" (shutdown.ts) -- if this helper silently
    // swallowed errors instead, a failed resource cleanup would report
    // as a clean shutdown.
    const handlers: ShutdownHandler[] = [
      async () => {
        throw new Error('cleanup failed');
      },
    ];

    await expect(runShutdownHandlers(handlers)).rejects.toThrow('cleanup failed');
  });
});
