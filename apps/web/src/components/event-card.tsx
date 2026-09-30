import Link from 'next/link';

import { Card } from './ui/card';
import { StatusBadge } from './ui/status-badge';

import type { Event } from '../lib/api/types';

/** Deterministic per-event gradient -- there's no image field on Event
 * anywhere in this data model, so a hashed two-stop brand-adjacent
 * gradient gives each card visual variety without pretending to have
 * artwork it doesn't. */
function gradientFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue1 = hash % 360;
  const hue2 = (hue1 + 45) % 360;
  return `linear-gradient(135deg, hsl(${hue1} 70% 22%), hsl(${hue2} 70% 14%))`;
}

function formatEventDate(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffDays = Math.round((date.getTime() - now) / 86_400_000);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Tomorrow, ${time}`;
  if (diffDays > 1 && diffDays < 7) return `In ${diffDays} days`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function EventCard({ event, showStatus = false }: { event: Event; showStatus?: boolean }): React.JSX.Element {
  return (
    <Link href={`/events/${event.id}`} className="group block">
      <Card className="overflow-hidden">
        <div
          className="flex h-28 items-end p-4"
          style={{ background: gradientFor(event.id) }}
        >
          {showStatus && <StatusBadge value={event.status} />}
        </div>
        <div className="space-y-1.5 p-4">
          <h3 className="line-clamp-1 font-semibold text-fg group-hover:text-brand-300">{event.name}</h3>
          <p className="text-sm text-fg-muted">{formatEventDate(event.startTime)}</p>
          <p className="line-clamp-1 text-xs text-fg-subtle">
            {event.venue.name}
            {event.venue.city ? `, ${event.venue.city}` : ''}
          </p>
        </div>
      </Card>
    </Link>
  );
}
