'use client';

import { useParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';

import { Card } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { StatusBadge } from '../../../components/ui/status-badge';
import { useToast } from '../../../components/ui/toast';
import { getTicket } from '../../../lib/api/endpoints/tickets';
import { handleApiError } from '../../../lib/api/handle-error';
import { formatMinor } from '../../../lib/api/money';

import type { TicketWithContext } from '../../../lib/api/types';

export default function TicketDetailPage(): React.JSX.Element {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { toast } = useToast();
  const [ticket, setTicket] = useState<TicketWithContext | null>(null);

  const load = useCallback(async () => {
    try {
      setTicket(await getTicket(ticketId));
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [ticketId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ticket) {
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-fg">Ticket</h1>
        <StatusBadge value={ticket.status} />
      </div>

      <Card className="flex flex-col items-center gap-5 p-6 text-center">
        {ticket.status === 'ISSUED' ? (
          <div className="rounded-lg bg-white p-4">
            <QRCodeSVG value={ticket.ticketNumber} size={200} />
          </div>
        ) : (
          // No scannable code for a cancelled ticket -- the booking was
          // refunded and the seat may already belong to someone else.
          <div className="flex size-[232px] items-center justify-center rounded-lg border border-dashed border-border-strong text-sm text-fg-subtle">
            Ticket cancelled
          </div>
        )}
        <div>
          <p className="font-mono text-sm text-fg">{ticket.ticketNumber}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            {ticket.status === 'ISSUED'
              ? 'Present this code at entry'
              : `Cancelled${ticket.cancelledAt ? ` ${new Date(ticket.cancelledAt).toLocaleString()}` : ''}`}
          </p>
        </div>
        <div className="w-full space-y-1 border-t border-border pt-4 text-left text-sm">
          <p className="font-semibold text-fg">{ticket.event.name}</p>
          <p className="text-fg-muted">
            {ticket.event.venue.name}
            {ticket.event.venue.city ? `, ${ticket.event.venue.city}` : ''}
          </p>
          <p className="text-fg-muted">{new Date(ticket.event.startTime).toLocaleString()}</p>
          <div className="flex items-center justify-between pt-2">
            <span className="text-fg-muted">Seat</span>
            <span className="text-fg">{ticket.seat.seatCode}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Price</span>
            <span className="text-fg">{formatMinor(ticket.seat.priceMinor, ticket.seat.currency)}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
