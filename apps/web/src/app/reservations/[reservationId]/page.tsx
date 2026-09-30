'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { CountdownBadge } from '../../../components/countdown-badge';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { StatusBadge } from '../../../components/ui/status-badge';
import { useToast } from '../../../components/ui/toast';
import { createOrder } from '../../../lib/api/endpoints/orders';
import { cancelReservation, getReservation } from '../../../lib/api/endpoints/reservations';
import { handleApiError } from '../../../lib/api/handle-error';
import { useIdempotentAction } from '../../../lib/api/idempotency';
import { formatMinor } from '../../../lib/api/money';

import type { Reservation } from '../../../lib/api/types';

export default function ReservationDetailPage(): React.JSX.Element {
  const { reservationId } = useParams<{ reservationId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setReservation(await getReservation(reservationId));
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [reservationId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const { run: runCheckout, isRunning: isCheckingOut } = useIdempotentAction((key: string) =>
    createOrder(key, reservationId),
  );

  async function handleCheckout(): Promise<void> {
    try {
      const order = await runCheckout();
      router.push(`/orders/${order.id}`);
    } catch (err) {
      handleApiError(err, { toast, onExpired: () => void load() });
    }
  }

  async function handleCancel(): Promise<void> {
    setIsCancelling(true);
    try {
      await cancelReservation(reservationId);
      toast({ kind: 'info', title: 'Reservation cancelled' });
      await load();
    } catch (err) {
      handleApiError(err, { toast });
    } finally {
      setIsCancelling(false);
    }
  }

  if (!reservation) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const totalMinor = reservation.items.reduce((sum, item) => sum + item.seat.priceMinor, 0);
  const currency = reservation.items[0]?.seat.currency ?? 'INR';

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-fg">Reservation</h1>
        <StatusBadge value={reservation.status} />
        {(reservation.status === 'RESERVED' || reservation.status === 'PENDING_PAYMENT') && (
          <CountdownBadge expiresAt={reservation.expiresAt} onExpire={() => void load()} />
        )}
      </div>

      <Card className="p-5">
        <ul className="divide-y divide-border">
          {reservation.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-fg">Seat {item.seat.seatCode}</span>
              <span className="text-fg-muted">{formatMinor(item.seat.priceMinor, item.seat.currency)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm font-semibold">
          <span className="text-fg">Total</span>
          <span className="text-fg">{formatMinor(totalMinor, currency)}</span>
        </div>
      </Card>

      {reservation.status === 'RESERVED' && (
        <p className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
          Demo payments: checkout uses a simulated payment provider. No card is needed and no real money is
          charged; payment confirms automatically after a few seconds.
        </p>
      )}

      {reservation.status === 'RESERVED' && (
        <div className="flex gap-3">
          <Button className="flex-1" isLoading={isCheckingOut} onClick={() => void handleCheckout()}>
            Proceed to checkout
          </Button>
          <Button variant="danger" isLoading={isCancelling} onClick={() => void handleCancel()}>
            Cancel
          </Button>
        </div>
      )}

      {reservation.status === 'PENDING_PAYMENT' && (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Checkout is in progress. If payment isn&apos;t confirmed in time, the seats are released
            automatically; any payment that arrives afterwards is refunded.
          </p>
          <Button variant="danger" isLoading={isCancelling} onClick={() => void handleCancel()}>
            Cancel checkout
          </Button>
        </div>
      )}
    </div>
  );
}
