import { EventCard } from '../../components/event-card';
import { EventFilters } from '../../components/event-filters';
import { Pagination } from '../../components/pagination';
import { EmptyState } from '../../components/ui/empty-state';
import { listEventsPublic } from '../../lib/api/endpoints/events';

interface EventsPageProps {
  searchParams: Promise<{ search?: string; page?: string }>;
}

const PAGE_SIZE = 12;

export default async function EventsPage({ searchParams }: EventsPageProps): Promise<React.JSX.Element> {
  const { search, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const { items, total, pageSize } = await listEventsPublic({
    ...(search ? { search } : {}),
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-fg">Events</h1>
        <EventFilters />
      </div>

      {items.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
          <Pagination page={page} pageSize={pageSize} total={total} />
        </>
      ) : (
        <EmptyState
          title="No events found"
          description={search ? `Nothing matches "${search}".` : 'Check back soon for upcoming events.'}
        />
      )}
    </div>
  );
}
