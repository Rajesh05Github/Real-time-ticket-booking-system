import { notFound } from 'next/navigation';

import { LiveViewerBadge } from '../../../components/live-viewer-badge';
import { EventSeatPanel } from '../../../components/seat-map/event-seat-panel';
import { StatusBadge } from '../../../components/ui/status-badge';
import { getEventPublic } from '../../../lib/api/endpoints/events';
import { getSeatAvailabilityPublic } from '../../../lib/api/endpoints/seats';
import { isApiError } from '../../../lib/api/errors';

interface EventDetailPageProps {
  params: Promise<{ eventId: string }>;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function gradientFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue1 = hash % 360;
  const hue2 = (hue1 + 45) % 360;
  return `linear-gradient(135deg, hsl(${hue1} 70% 22%), hsl(${hue2} 70% 14%))`;
}

export default async function EventDetailPage({ params }: EventDetailPageProps): Promise<React.JSX.Element> {
  const { eventId } = await params;

  let event;
  try {
    event = await getEventPublic(eventId);
  } catch (err) {
    if (isApiError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }

  const availability = await getSeatAvailabilityPublic(eventId).catch(() => null);

  return (
    <div className="space-y-8">
      <div
        className="flex h-40 items-end justify-between rounded-xl p-6 sm:h-56"
        style={{ background: gradientFor(event.id) }}
      >
        <div>
          <StatusBadge value={event.status} />
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">{event.name}</h1>
        </div>
        <LiveViewerBadge eventId={event.id} />
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <h2 className="text-lg font-semibold text-fg">Select your seats</h2>
          {availability ? (
            <EventSeatPanel eventId={event.id} eventStatus={event.status} availability={availability} />
          ) : (
            <p className="text-sm text-fg-muted">Seating information isn&apos;t available right now.</p>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-sm font-medium text-fg">{formatDateTime(event.startTime)}</p>
            <p className="mt-1 text-sm text-fg-muted">
              {event.venue.name}
              {event.venue.city ? `, ${event.venue.city}` : ''}
            </p>
            {event.description && <p className="mt-3 text-sm text-fg-subtle">{event.description}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
