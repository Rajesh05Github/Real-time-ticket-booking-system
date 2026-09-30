'use client';

import { useState } from 'react';

import { useEventLive } from './use-event-live';

/** The live "N watching" count for an event. Returns `null` (not 0)
 * whenever the socket isn't currently connected -- a viewer count of "0"
 * and "we don't know" must never look the same in the UI. Rides on the
 * shared per-event socket (use-event-live.ts), so it and the seat map
 * never open two connections from one tab. */
export function useLiveViewerCount(eventId: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEventLive(eventId, (message) => {
    if (message.type === 'viewerCount' && typeof message.count === 'number') {
      setCount(message.count);
    } else if (message.type === 'disconnected') {
      setCount(null);
    }
  });

  return count;
}
