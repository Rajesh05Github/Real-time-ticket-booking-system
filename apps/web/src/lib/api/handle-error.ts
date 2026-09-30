import { errorCopyFor, isApiError } from './errors';

import type { ToastOptions } from '../../components/ui/toast';

export interface HandleApiErrorOptions {
  toast: (options: ToastOptions) => void;
  /** Called for SEAT_NOT_AVAILABLE -- the caller should clear its
   * selection and refetch availability. */
  onSeatConflict?: () => void;
  /** Called for RESERVATION_EXPIRED / EXPIRED-adjacent conflicts. */
  onExpired?: () => void;
}

/**
 * The one place every page routes a thrown ApiError through, instead of
 * re-implementing the same code -> copy -> toast branch three times.
 * Non-ApiError (a real bug, a thrown TypeError from application code)
 * gets a generic toast rather than silently swallowed.
 */
export function handleApiError(err: unknown, options: HandleApiErrorOptions): void {
  if (!isApiError(err)) {
    options.toast({ kind: 'error', title: 'Something went wrong.', description: String(err) });
    return;
  }

  const description = errorCopyFor(err);

  if (err.code === 'SEAT_NOT_AVAILABLE') {
    options.toast({ kind: 'error', title: 'Seat unavailable', description });
    options.onSeatConflict?.();
    return;
  }

  if (err.code === 'RESERVATION_EXPIRED' || err.code === 'INVALID_STATUS_TRANSITION') {
    options.toast({ kind: 'error', title: 'This changed', description });
    options.onExpired?.();
    return;
  }

  if (err.code === 'RATE_LIMIT_EXCEEDED') {
    const seconds = err.retryAfterSeconds;
    options.toast({
      kind: 'error',
      title: 'Slow down',
      description: seconds ? `Try again in ${seconds}s.` : description,
    });
    return;
  }

  options.toast({
    kind: 'error',
    title: err.code === 'INTERNAL_SERVER_ERROR' ? 'Something went wrong' : 'Request failed',
    description,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  });
}
