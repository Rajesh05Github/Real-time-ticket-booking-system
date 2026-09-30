'use client';

import { useCallback, useRef, useState } from 'react';

import { isApiError } from './errors';

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

interface UseIdempotentActionResult<Args extends unknown[], T> {
  run: (...args: Args) => Promise<T>;
  isRunning: boolean;
  /** Call after a successful terminal outcome, or when the user changes
   * the underlying inputs (e.g. picks different seats) -- the NEXT run()
   * mints a fresh key instead of reusing this one. */
  reset: () => void;
}

/**
 * The single highest-risk correctness detail in this frontend: an
 * Idempotency-Key identifies a user INTENTION ("pay for this order"),
 * not an HTTP attempt. A double-clicked Pay button, this hook's own
 * auto-retry on REQUEST_IN_PROGRESS, and a manual "try again" tap must
 * all carry the SAME key -- regenerating one per click is indistinguishable
 * from the bug this whole header exists to prevent (apps/api/src/plugins/
 * idempotency.ts's INSERT-as-lock only protects a request that reuses the
 * same key).
 *
 * The key is minted lazily on the FIRST `run()` call (not on mount --
 * most components using this never end up calling it at all) and held
 * in a ref so it survives re-renders without becoming a dependency of
 * anything. `reset()` is the only thing that clears it, called by the
 * caller once the action has truly concluded (success, or the user
 * changed what they're doing).
 */
export function useIdempotentAction<Args extends unknown[], T>(
  action: (idempotencyKey: string, ...args: Args) => Promise<T>,
): UseIdempotentActionResult<Args, T> {
  const keyRef = useRef<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const run = useCallback(
    async (...args: Args): Promise<T> => {
      keyRef.current ??= newIdempotencyKey();
      const key = keyRef.current;

      setIsRunning(true);
      try {
        return await action(key, ...args);
      } catch (err) {
        // A REQUEST_IN_PROGRESS response means a previous attempt with
        // this SAME key is still being processed server-side (e.g. a
        // double-click raced ahead of the first request's response) --
        // one short, single auto-retry with the SAME key is safe and
        // usually resolves it, since the guard.ts idempotency table
        // will have flipped to COMPLETED/FAILED by then.
        if (isApiError(err) && err.code === 'REQUEST_IN_PROGRESS') {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return await action(key, ...args);
        }
        throw err;
      } finally {
        setIsRunning(false);
      }
    },
    [action],
  );

  const reset = useCallback(() => {
    keyRef.current = null;
  }, []);

  return { run, isRunning, reset };
}
