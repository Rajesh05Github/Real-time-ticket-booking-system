import { RESERVATION_SWEEP_INTERVAL_MS } from '@flashsale/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@flashsale/database', () => ({
  findExpiredReservationIds: vi.fn(),
  releaseReservation: vi.fn(),
}));

const { findExpiredReservationIds, releaseReservation } = await import('@flashsale/database');
const { startReservationExpirySweeper } = await import('./reservation-expiry-sweep.js');

import type { Logger } from '@flashsale/logger';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startReservationExpirySweeper', () => {
  // This test file's vitest.config.ts doesn't set clearMocks/restoreMocks
  // -- without an explicit reset, mock call counts (and, worse,
  // mockImplementationOnce-style state) would leak between tests here,
  // which matters more than usual for a suite whose whole point is
  // asserting exact call counts.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "stop() awaits an IN-FLIGHT tick rather than just clearing the timer -- the exact class of bug " +
      'register-shutdown-hooks.ts documents for the BullMQ workers, applied to this plain interval',
    async () => {
      let releaseResolve!: () => void;
      vi.mocked(findExpiredReservationIds).mockResolvedValue([{ id: 'res-1' }]);
      vi.mocked(releaseReservation).mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseResolve = () => resolve({ released: true, seatIds: ['seat-1'] });
          }),
      );

      const sweeper = startReservationExpirySweeper(silentLogger);
      // Directly exercise the sweeper's internals by waiting for its own
      // interval would make this test slow and timing-flaky; instead we
      // reach the same "a tick is in flight" state deterministically by
      // triggering one via the real interval callback path is avoided --
      // this test instead asserts the CONTRACT stop() promises: it must
      // not resolve while releaseReservation (a stand-in for a live
      // Prisma call) is still pending.
      await vi.waitFor(() => expect(releaseReservation).toHaveBeenCalled(), { timeout: 2000 });

      let stopResolved = false;
      const stopPromise = sweeper.stop().then(() => {
        stopResolved = true;
      });

      await delay(20);
      expect(stopResolved).toBe(false); // releaseReservation still pending -- stop() must still be waiting

      releaseResolve();
      await stopPromise;
      expect(stopResolved).toBe(true);
    },
    3000,
  );

  it('skips a tick that would overlap a still-running one', async () => {
    vi.useFakeTimers();
    try {
      let releaseResolve!: () => void;
      vi.mocked(findExpiredReservationIds).mockResolvedValue([{ id: 'res-1' }]);
      vi.mocked(releaseReservation).mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseResolve = () => resolve({ released: true, seatIds: [] });
          }),
      );

      const sweeper = startReservationExpirySweeper(silentLogger);
      await vi.advanceTimersByTimeAsync(0); // flush the immediate startup tick's synchronous call
      expect(findExpiredReservationIds).toHaveBeenCalledTimes(1);

      // Advance past TWO full interval periods while the first tick's
      // releaseReservation call is still pending -- if overlap protection
      // didn't work, this would trigger additional scans.
      await vi.advanceTimersByTimeAsync(RESERVATION_SWEEP_INTERVAL_MS * 2);
      expect(findExpiredReservationIds).toHaveBeenCalledTimes(1);

      releaseResolve();
      await sweeper.stop();

      expect(findExpiredReservationIds).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and continues past a single reservation failing to release, without aborting the batch', async () => {
    vi.mocked(findExpiredReservationIds).mockResolvedValue([{ id: 'res-bad' }, { id: 'res-good' }]);
    vi.mocked(releaseReservation)
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce({ released: true, seatIds: ['seat-1'] });

    const sweeper = startReservationExpirySweeper(silentLogger);
    await vi.waitFor(() => expect(releaseReservation).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await sweeper.stop();

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'res-bad' }),
      'failed to expire reservation',
    );
  });
});
