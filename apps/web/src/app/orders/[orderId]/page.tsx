'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Dialog } from '../../../components/ui/dialog';
import { Skeleton } from '../../../components/ui/skeleton';
import { StatusBadge } from '../../../components/ui/status-badge';
import { useToast } from '../../../components/ui/toast';
import { cancelOrder, retryPayment } from '../../../lib/api/endpoints/orders';
import { handleApiError } from '../../../lib/api/handle-error';
import { useIdempotentAction } from '../../../lib/api/idempotency';
import { formatMinor } from '../../../lib/api/money';
import { useOrderPolling } from '../../../lib/hooks/use-order-polling';

export default function OrderDetailPage(): React.JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const { toast } = useToast();
  const { order, timedOut, refresh } = useOrderPolling(orderId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { run: runRetry, isRunning: isRetrying, reset: resetRetry } = useIdempotentAction((key: string) =>
    retryPayment(key, orderId),
  );
  const { run: runCancel, isRunning: isCancelling, reset: resetCancel } = useIdempotentAction((key: string) =>
    cancelOrder(key, orderId),
  );

  useEffect(() => {
    if (order?.status !== 'PENDING') resetRetry();
  }, [order?.status, resetRetry]);

  // A new status means any earlier cancel intent is settled -- the next
  // click is a new intent and needs a fresh idempotency key.
  useEffect(() => {
    resetCancel();
  }, [order?.status, resetCancel]);

  async function handleRetry(): Promise<void> {
    try {
      await runRetry();
      toast({ kind: 'info', title: 'Retrying payment' });
      await refresh();
    } catch (err) {
      handleApiError(err, { toast, onExpired: () => void refresh() });
    }
  }

  async function handleCancel(): Promise<void> {
    const wasPaid = order?.status === 'PAID';
    try {
      await runCancel();
      setConfirmOpen(false);
      toast(
        wasPaid
          ? { kind: 'info', title: 'Booking cancelled', description: 'Your tickets were cancelled and a refund is on its way.' }
          : { kind: 'info', title: 'Checkout cancelled', description: 'Your seats were released.' },
      );
      await refresh();
    } catch (err) {
      setConfirmOpen(false);
      handleApiError(err, { toast, onExpired: () => void refresh() });
      await refresh();
    }
  }

  if (!order) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const canRetry = order.status === 'PENDING' && order.payments.some((p) => p.status === 'FAILED');
  const showTickets = order.status === 'PAID' || order.status === 'REFUNDED';

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-fg">Order</h1>
        <StatusBadge value={order.status} />
        {order.status === 'PENDING' && (
          <span className="tnum text-xs text-fg-subtle">
            {timedOut ? 'Still pending' : 'Awaiting payment confirmation…'}
          </span>
        )}
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-fg-muted">Total</span>
          <span className="font-semibold text-fg">{formatMinor(order.amountMinor, order.currency)}</span>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">Placed {new Date(order.createdAt).toLocaleString()}</p>
        <p className="mt-2 text-xs text-info">Demo payment: simulated, no real money was charged or will be refunded.</p>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-fg">Payments</h2>
        {order.payments.length === 0 ? (
          <p className="text-sm text-fg-muted">No payment attempts yet.</p>
        ) : (
          <div className="space-y-2">
            {order.payments.map((payment) => (
              <Card key={payment.id} className="flex items-center justify-between p-3 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge value={payment.status} />
                  <span className="text-fg-muted">{payment.provider}</span>
                </div>
                <span className="text-fg">{formatMinor(payment.amountMinor, payment.currency)}</span>
              </Card>
            ))}
          </div>
        )}
        {order.payments.some((p) => p.status === 'REFUND_PENDING') && (
          <p className="text-xs text-fg-subtle">Refunds are processed automatically, usually within a minute.</p>
        )}
      </div>

      {order.status === 'PENDING' && (
        <div className="flex flex-wrap gap-3">
          {canRetry && (
            <Button isLoading={isRetrying} onClick={() => void handleRetry()}>
              Retry payment
            </Button>
          )}
          {timedOut && (
            <Button variant="secondary" onClick={() => void refresh()}>
              Refresh
            </Button>
          )}
          <Button variant="danger" isLoading={isCancelling} onClick={() => void handleCancel()}>
            Cancel checkout
          </Button>
        </div>
      )}

      {showTickets && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-fg">Tickets</h2>
          {order.tickets.length === 0 ? (
            <p className="text-sm text-fg-muted">Tickets are being issued…</p>
          ) : (
            <div className="space-y-2">
              {order.tickets.map((ticket) => (
                <Card key={ticket.id} className="flex items-center justify-between p-3 text-sm">
                  <div>
                    <p className="font-mono text-fg">{ticket.ticketNumber}</p>
                    <StatusBadge value={ticket.status} />
                  </div>
                  <Link href={`/tickets/${ticket.id}`}>
                    <Button variant="secondary" size="sm">
                      View ticket
                    </Button>
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {order.status === 'PAID' && (
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Cancel booking &amp; refund
        </Button>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Cancel this booking?">
        <p className="text-sm text-fg-muted">
          All {order.tickets.filter((t) => t.status === 'ISSUED').length} ticket(s) on this order will be cancelled,
          the seats go back on sale, and {formatMinor(order.amountMinor, order.currency)} will be refunded. This
          can&apos;t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Keep booking
          </Button>
          <Button variant="danger" isLoading={isCancelling} onClick={() => void handleCancel()}>
            Cancel booking
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
