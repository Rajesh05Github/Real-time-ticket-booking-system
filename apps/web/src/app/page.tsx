import Link from 'next/link';

import { EventCard } from '../components/event-card';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { getTrendingEventsPublic, listEventsPublic } from '../lib/api/endpoints/events';

import type { Event } from '../lib/api/types';

async function safeList(fn: () => Promise<Event[]>): Promise<Event[]> {
  // The home page must render even if the API is briefly unreachable --
  // an empty rail is a much better failure mode than a 500 for the one
  // page every visitor lands on first.
  try {
    return await fn();
  } catch {
    return [];
  }
}

export default async function HomePage(): Promise<React.JSX.Element> {
  const [trending, upcoming] = await Promise.all([
    safeList(() => getTrendingEventsPublic(6)),
    safeList(async () => (await listEventsPublic({ pageSize: 6 })).items),
  ]);

  return (
    <div className="space-y-16">
      <section className="flex flex-col items-start gap-4 py-8">
        <h1 className="text-4xl font-bold tracking-tight text-fg sm:text-5xl">
          Get in before it&apos;s <span className="text-brand-400">gone</span>.
        </h1>
        <p className="max-w-xl text-fg-muted">
          Real seats, real-time availability, no overselling -- built on a Postgres-correct,
          Redis-fast reservation system.
        </p>
        <Link href="/events">
          <Button size="lg">Browse events</Button>
        </Link>
      </section>

      {trending.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-fg">Trending now</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {trending.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">Upcoming events</h2>
          <Link href="/events" className="text-sm text-brand-300 hover:text-brand-200">
            View all →
          </Link>
        </div>
        {upcoming.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState title="No events yet" description="Check back soon, or ask an admin to publish one." />
        )}
      </section>
    </div>
  );
}
