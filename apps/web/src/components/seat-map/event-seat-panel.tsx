'use client';

import { MAX_SEATS_PER_RESERVATION } from '@flashsale/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { createReservation } from '../../lib/api/endpoints/reservations';
import { handleApiError } from '../../lib/api/handle-error';
import { useIdempotentAction } from '../../lib/api/idempotency';
import { useAuth } from '../../lib/auth/auth-context';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';

import { SeatMap } from './seat-map';

import type { SeatAvailability } from '../../lib/api/types';

interface EventSeatPanelProps {
  eventId: string;
  eventStatus: string;
  availability: SeatAvailability;
}

/** Bridges the read-only `SeatMap` to the authenticated reserve action --
 * split out from the event detail page (a Server Component) because
 * reserving requires `useAuth`/`useIdempotentAction`/router, all client-only. */
export function EventSeatPanel({ eventId, eventStatus, availability }: EventSeatPanelProps): React.JSX.Element {
  const { status } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const { run, isRunning, reset } = useIdempotentAction((key: string, seatIds: string[]) =>
    createReservation(key, eventId, seatIds),
  );

  async function handleReserve(seatIds: string[]): Promise<void> {
    if (seatIds.length === 0) return;
    try {
      const reservation = await run(seatIds);
      reset();
      toast({ kind: 'success', title: 'Seats held', description: 'Complete checkout before the hold expires.' });
      router.push(`/reservations/${reservation.id}`);
    } catch (err) {
      handleApiError(err, { toast });
      throw err;
    }
  }

  if (eventStatus !== 'PUBLISHED') {
    return <p className="text-sm text-fg-muted">This event is not open for booking.</p>;
  }

  if (status === 'anonymous') {
    return (
      <div className="space-y-4">
        <SeatMap
          eventId={eventId}
          initialAvailability={availability}
          maxSeats={MAX_SEATS_PER_RESERVATION}
          isReserving={false}
          onReserve={() => {
            router.push(`/login?next=/events/${eventId}`);
            return Promise.resolve();
          }}
        />
        <p className="text-sm text-fg-muted">
          <Link href={`/login?next=/events/${eventId}`} className="text-brand-300 hover:text-brand-200">
            Log in
          </Link>{' '}
          to select and hold seats.
        </p>
      </div>
    );
  }

  if (status === 'loading') {
    return <Button variant="secondary" isLoading disabled className="w-full" />;
  }

  return (
    <SeatMap
      eventId={eventId}
      initialAvailability={availability}
      maxSeats={MAX_SEATS_PER_RESERVATION}
      isReserving={isRunning}
      onReserve={handleReserve}
    />
  );
}
