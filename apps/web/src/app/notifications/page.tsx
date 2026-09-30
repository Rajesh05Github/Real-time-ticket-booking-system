'use client';

import { useCallback, useEffect, useState } from 'react';

import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { listNotifications } from '../../lib/api/endpoints/notifications';
import { handleApiError } from '../../lib/api/handle-error';

import type { NotificationItem } from '../../lib/api/types';

/**
 * The feed's shape beyond the OTP case isn't fully confirmed (see
 * NotificationItem's own doc comment) -- known types get friendly copy,
 * anything else falls through to a generic line built from `type` alone
 * so a future notification kind never renders as a blank/broken row.
 */
const TYPE_COPY: Record<string, { title: string; description: string }> = {
  otp_verification: {
    title: 'Verification code sent',
    description: 'We sent a one-time code to verify your email.',
  },
  'reservation.created': { title: 'Seats held', description: 'Complete checkout before your hold expires.' },
  'reservation.cancelled': { title: 'Reservation cancelled', description: 'Your held seats were released.' },
  'reservation.expired': {
    title: 'Reservation expired',
    description: 'Your hold (or unfinished checkout) timed out and the seats were released.',
  },
  'order.created': { title: 'Checkout started', description: 'We are waiting for your payment to be confirmed.' },
  'order.paid': { title: 'Payment confirmed', description: 'Your tickets are ready.' },
  'order.cancelled': { title: 'Checkout cancelled', description: 'Your order was cancelled before payment completed.' },
  'order.refunded': {
    title: 'Booking cancelled',
    description: 'Your tickets were cancelled and a refund has been requested.',
  },
  'payment.failed': { title: 'Payment failed', description: 'You can retry the payment from your order.' },
  'payment.refund_requested': {
    title: 'Refund on the way',
    description: 'A payment arrived after your order was closed, so we are refunding it automatically.',
  },
  'payment.refunded': { title: 'Refund issued', description: 'Your payment has been refunded.' },
};

function describe(notification: NotificationItem): { title: string; description: string } {
  const known = TYPE_COPY[notification.type];
  if (known) return known;
  return {
    title: notification.type.replace(/_/g, ' '),
    description: 'You have a new notification.',
  };
}

function NotificationsLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

export default function NotificationsPage(): React.JSX.Element {
  const { toast } = useToast();
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      setNotifications(await listNotifications());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Notifications</h1>

      {notifications === null ? (
        <NotificationsLoading />
      ) : notifications.length === 0 ? (
        <EmptyState title="No notifications" description="You're all caught up." />
      ) : (
        <div className="space-y-2">
          {notifications.map((notification) => {
            const { title, description } = describe(notification);
            return (
              <Card key={notification.id} className="flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="text-sm font-medium capitalize text-fg">{title}</p>
                  <p className="text-sm text-fg-muted">{description}</p>
                </div>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {new Date(notification.createdAt).toLocaleString()}
                </span>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
