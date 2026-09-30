'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { StatusBadge } from '../../components/ui/status-badge';
import { useToast } from '../../components/ui/toast';
import { listOrders } from '../../lib/api/endpoints/orders';
import { handleApiError } from '../../lib/api/handle-error';
import { formatMinor } from '../../lib/api/money';

import type { Order } from '../../lib/api/types';

function OrdersLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

export default function OrdersPage(): React.JSX.Element {
  const { toast } = useToast();
  const [orders, setOrders] = useState<Order[] | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await listOrders());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Your orders</h1>

      {orders === null ? (
        <OrdersLoading />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Reserve seats and check out to see your orders here."
          action={
            <Link href="/events">
              <Button size="sm">Browse events</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge value={order.status} />
                  <span className="text-xs text-fg-subtle">
                    {new Date(order.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  {order.tickets.length} ticket{order.tickets.length === 1 ? '' : 's'} &middot;{' '}
                  {formatMinor(order.amountMinor, order.currency)}
                </p>
              </div>
              <Link href={`/orders/${order.id}`}>
                <Button variant="secondary" size="sm">
                  View
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
