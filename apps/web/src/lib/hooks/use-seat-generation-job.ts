'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { generateSeats, getSeatGenerationJob } from '../api/endpoints/seats';

import type { Seat, SeatGenerationAssignment } from '../api/types';

const POLL_INTERVAL_MS = 1500;

interface UseSeatGenerationJobResult {
  /** 'idle' before the first submit; 'sync-done'/'async-done' are terminal
   * successes; 'failed' is terminal too -- 'submitting'/'polling' are the
   * only states where the caller should show a progress indicator. */
  state: 'idle' | 'submitting' | 'polling' | 'sync-done' | 'async-done' | 'failed';
  seats: Seat[] | null;
  progress: number | object | null;
  error: string | null;
  submit: (eventId: string, assignments: SeatGenerationAssignment[]) => Promise<void>;
}

/**
 * generateSeats returns a discriminated union: small assignments complete
 * synchronously (201, seats already in the response); large ones (seat
 * generation allows up to 100,000 seats per assignment) are handed off to
 * a BullMQ job and return 202 + a jobId that must be polled until the job
 * reaches a terminal state.
 */
export function useSeatGenerationJob(): UseSeatGenerationJobResult {
  const [state, setState] = useState<UseSeatGenerationJobResult['state']>('idle');
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [progress, setProgress] = useState<number | object | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    return () => {
      stoppedRef.current = true;
    };
  }, []);

  const submit = useCallback(
    async (eventId: string, assignments: SeatGenerationAssignment[]): Promise<void> => {
      stoppedRef.current = false;
      setState('submitting');
      setSeats(null);
      setProgress(null);
      setError(null);

      const result = await generateSeats(eventId, assignments);

      if (result.mode === 'sync') {
        setSeats(result.seats);
        setState('sync-done');
        return;
      }

      setState('polling');
      const { jobId } = result;

      async function poll(): Promise<void> {
        if (stoppedRef.current) return;
        const job = await getSeatGenerationJob(eventId, jobId);
        if (stoppedRef.current) return;
        setProgress(job.progress);

        if (job.state === 'completed') {
          setState('async-done');
          return;
        }
        if (job.state === 'failed') {
          setError(job.failedReason ?? 'Seat generation failed.');
          setState('failed');
          return;
        }
        setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }

      await poll();
    },
    [],
  );

  return { state, seats, progress, error, submit };
}
