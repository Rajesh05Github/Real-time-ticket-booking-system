'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { CountdownBadge } from '../../components/countdown-badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { StatusBadge } from '../../components/ui/status-badge';
import { useToast } from '../../components/ui/toast';
import { cancelReservation, listReservations } from '../../lib/api/endpoints/reservations';
import { handleApiError } from '../../lib/api/handle-error';
import { formatMinor } from '../../lib/api/money';

import type { Reservation } from '../../lib/api/types';

function ReservationsLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

export default function ReservationsPage(): React.JSX.Element {
  const { toast } = useToast();
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReservations(await listReservations());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(id: string): Promise<void> {
    setCancelingId(id);
    try {
      await cancelReservation(id);
      toast({ kind: 'info', title: 'Reservation cancelled' });
      await load();
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Your reservations</h1>

      {reservations === null ? (
        <ReservationsLoading />
      ) : reservations.length === 0 ? (
        <EmptyState
          title="No reservations yet"
          description="Browse events and select seats to hold them."
          action={
            <Link href="/events">
              <Button size="sm">Browse events</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {reservations.map((reservation) => {
            const totalMinor = reservation.items.reduce((sum, item) => sum + item.seat.priceMinor, 0);
            const currency = reservation.items[0]?.seat.currency ?? 'INR';
            return (
              <Card key={reservation.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusBadge value={reservation.status} />
                    {reservation.status === 'RESERVED' && (
                      <CountdownBadge expiresAt={reservation.expiresAt} onExpire={() => void load()} />
                    )}
                  </div>
                  <p className="mt-1 text-sm text-fg-muted">
                    {reservation.items.length} seat{reservation.items.length === 1 ? '' : 's'} &middot;{' '}
                    {formatMinor(totalMinor, currency)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link href={`/reservations/${reservation.id}`}>
                    <Button variant="secondary" size="sm">
                      View
                    </Button>
                  </Link>
                  {reservation.status === 'RESERVED' && (
                    <Button
                      variant="danger"
                      size="sm"
                      isLoading={cancelingId === reservation.id}
                      onClick={() => void handleCancel(reservation.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
