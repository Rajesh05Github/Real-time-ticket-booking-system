export interface PeriodicJob {
  /** Clears the timer AND awaits any in-flight tick, so shutdown never
   * disconnects Prisma underneath a running tick (the same contract
   * reservation-expiry-sweep.ts documents). */
  stop: () => Promise<void>;
}

/**
 * The run-once-now, then-every-N-ms, never-overlapping shape shared by
 * the worker's housekeeping loops. Same mechanics as the reservation
 * sweeper's hand-written loop: a tick still running when the next
 * interval fires is skipped, not overlapped.
 */
export function startPeriodicJob(intervalMs: number, tick: () => Promise<void>): PeriodicJob {
  let currentTick: Promise<void> | null = null;
  let stopped = false;

  function fireTick(): void {
    if (currentTick || stopped) {
      return;
    }
    currentTick = tick().finally(() => {
      currentTick = null;
    });
  }

  fireTick();
  const interval = setInterval(fireTick, intervalMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await currentTick;
    },
  };
}
