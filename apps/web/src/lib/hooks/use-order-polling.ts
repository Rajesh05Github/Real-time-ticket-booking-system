'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getOrder } from '../api/endpoints/orders';

import type { Order } from '../api/types';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 90_000;

interface UseOrderPollingResult {
  order: Order | null;
  /** True once polling has given up after MAX_POLL_MS while still PENDING --
   * the caller should show a manual "Refresh" affordance instead of spinning
   * forever on a payment worker that may be stuck or slow. */
  timedOut: boolean;
  refresh: () => Promise<void>;
}

/**
 * Polls GET /orders/:id every ~2s only while status is PENDING, pausing
 * entirely when the tab is hidden (document.hidden) so a backgrounded tab
 * doesn't hammer the API, and gives up after ~90s of PENDING with a
 * timedOut flag rather than polling indefinitely -- the worker confirms
 * payment out-of-band and could in principle never resolve.
 */
export function useOrderPolling(orderId: string): UseOrderPollingResult {
  const [order, setOrder] = useState<Order | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startRef = useRef<number>(Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    setOrder(await getOrder(orderId));
  }, [orderId]);

  useEffect(() => {
    startRef.current = Date.now();
    setTimedOut(false);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      if (stopped || document.hidden) return;
      try {
        const fresh = await getOrder(orderId);
        if (stopped) return;
        setOrder(fresh);
        if (fresh.status !== 'PENDING') return;
      } catch {
        // Transient fetch failure -- keep polling, the next tick may succeed.
      }
      if (stopped) return;
      if (Date.now() - startRef.current >= MAX_POLL_MS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }

    void tick();

    // A tick scheduled while hidden returns immediately without fetching or
    // rescheduling -- this listener is what resumes polling once the tab
    // becomes visible again, rather than polling blindly in the background.
    function handleVisibility(): void {
      if (!document.hidden && !stopped) {
        clearTimeout(timer);
        void tick();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [orderId, refresh]);

  return { order, timedOut, refresh };
}
