'use client';

import { useEffect, useRef, useState } from 'react';

const TICK_MS = 1000;
export const URGENT_THRESHOLD_SECONDS = 60;

interface CountdownResult {
  secondsLeft: number;
  isUrgent: boolean;
  isExpired: boolean;
}

/** Recomputes remaining seconds from wall-clock (`expiresAt` vs `Date.now()`)
 * on every tick, rather than decrementing a counter -- a decrementing counter
 * drifts the moment the tab is backgrounded and timers get throttled, which
 * is exactly when a reservation hold is most likely to actually expire.
 * `onExpire` fires exactly once. */
export function useCountdown(expiresAt: string, onExpire?: () => void): CountdownResult {
  const expiresAtMs = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  const isExpired = secondsLeft <= 0;

  useEffect(() => {
    if (isExpired && !firedRef.current) {
      firedRef.current = true;
      onExpire?.();
    }
  }, [isExpired, onExpire]);

  return { secondsLeft, isExpired, isUrgent: !isExpired && secondsLeft <= URGENT_THRESHOLD_SECONDS };
}
