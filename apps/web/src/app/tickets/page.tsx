'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { Skeleton } from '../../components/ui/skeleton';
import { StatusBadge } from '../../components/ui/status-badge';
import { useToast } from '../../components/ui/toast';
import { listTickets } from '../../lib/api/endpoints/tickets';
import { handleApiError } from '../../lib/api/handle-error';

import type { TicketWithContext } from '../../lib/api/types';

function TicketsLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

export default function TicketsPage(): React.JSX.Element {
  const { toast } = useToast();
  const [tickets, setTickets] = useState<TicketWithContext[] | null>(null);

  const load = useCallback(async () => {
    try {
      setTickets(await listTickets());
    } catch (err) {
      handleApiError(err, { toast });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-fg">Your tickets</h1>

      {tickets === null ? (
        <TicketsLoading />
      ) : tickets.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          description="Tickets appear here once an order is paid."
          action={
            <Link href="/events">
              <Button size="sm">Browse events</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <Card key={ticket.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge value={ticket.status} />
                  <span className="text-sm font-medium text-fg">{ticket.event.name}</span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  Seat {ticket.seat.seatCode} &middot; <span className="font-mono">{ticket.ticketNumber}</span>
                </p>
              </div>
              <Link href={`/tickets/${ticket.id}`}>
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
