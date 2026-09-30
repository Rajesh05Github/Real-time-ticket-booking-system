import { prisma, type Event, type EventStatus, type Prisma } from '@flashsale/database';

// `satisfies Prisma.EventInclude` + `Prisma.EventGetPayload`, not a bare
// `Event & { venue: Venue }` -- the robust, Prisma-recommended way to
// type a query's nested-include result shape (see order.repository.ts's
// PaymentWithContext for the established precedent on why inferring this
// through `ReturnType<typeof queryFn>` doesn't reliably widen through
// Prisma's fluent promise type).
const eventWithVenueInclude = {
  venue: { select: { id: true, name: true, city: true } },
} satisfies Prisma.EventInclude;

export type EventWithVenue = Prisma.EventGetPayload<{ include: typeof eventWithVenueInclude }>;

export function createEvent(data: {
  venueId: string;
  name: string;
  // `?: T | undefined`: matches what Zod's `.optional()` actually infers
  // (event.schema.ts) -- both an optional key and an undefined-inclusive
  // value. See the conditional spreads below for the Prisma-boundary
  // side of this same exactOptionalPropertyTypes pattern.
  description?: string | undefined;
  startTime: Date;
  endTime?: Date | undefined;
}): Promise<Event> {
  return prisma.event.create({
    data: {
      venueId: data.venueId,
      name: data.name,
      startTime: data.startTime,
      // Conditionally spread: Prisma's input type marks these optional
      // (`field?: string | null`), and exactOptionalPropertyTypes treats
      // "key present with value undefined" as a disallowed shape
      // distinct from "key omitted".
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
    },
  });
}

export function findEventById(id: string): Promise<EventWithVenue | null> {
  return prisma.event.findUnique({ where: { id }, include: eventWithVenueInclude });
}

/**
 * Order is NOT guaranteed to match `ids`' order -- Prisma's `IN` query
 * returns rows in whatever order Postgres produces them. Callers that
 * need a specific order (event.service.ts's getTrendingEvents, which
 * needs Redis's rank order) build a Map from this result and iterate
 * their own ordered id list instead of relying on this function's
 * output order.
 */
export function findManyByIds(ids: string[]): Promise<EventWithVenue[]> {
  return prisma.event.findMany({ where: { id: { in: ids } }, include: eventWithVenueInclude });
}

export function updateEvent(
  id: string,
  data: {
    name?: string | undefined;
    description?: string | undefined;
    startTime?: Date | undefined;
    endTime?: Date | undefined;
  },
): Promise<Event> {
  return prisma.event.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
      ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
    },
  });
}

export function updateEventStatus(id: string, status: EventStatus): Promise<Event> {
  return prisma.event.update({ where: { id }, data: { status } });
}

export interface ListEventsFilter {
  status: EventStatus | undefined;
  search: string | undefined;
  venueId: string | undefined;
  startTimeFrom: Date | undefined;
  startTimeTo: Date | undefined;
  page: number;
  pageSize: number;
}

export async function listEvents(
  filter: ListEventsFilter,
): Promise<{ events: EventWithVenue[]; total: number }> {
  const where: Prisma.EventWhereInput = {
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.venueId !== undefined ? { venueId: filter.venueId } : {}),
    ...(filter.search !== undefined
      ? {
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' } },
            { description: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(filter.startTimeFrom !== undefined || filter.startTimeTo !== undefined
      ? {
          startTime: {
            ...(filter.startTimeFrom !== undefined ? { gte: filter.startTimeFrom } : {}),
            ...(filter.startTimeTo !== undefined ? { lte: filter.startTimeTo } : {}),
          },
        }
      : {}),
  };

  // One round trip for the page, one for the total count -- run
  // concurrently rather than sequentially since neither depends on the
  // other's result.
  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
      include: eventWithVenueInclude,
      orderBy: { startTime: 'asc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.event.count({ where }),
  ]);

  return { events, total };
}

export function countSeatsForEvent(eventId: string): Promise<number> {
  return prisma.seat.count({ where: { eventId } });
}
