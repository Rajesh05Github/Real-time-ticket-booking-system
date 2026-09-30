import { recordAuditLog, type Event, type EventStatus } from '@flashsale/database';
import { DomainBadRequestError, DomainConflictError, NotFoundError } from '@flashsale/shared';

import { getVenueOrThrow } from '../venues/venue.service.js';

import {
  getOrSetEventCache,
  getOrSetEventListCache,
  invalidateEventCache,
  invalidateEventListCache,
  type SerializedEvent,
} from './event-cache.js';
import {
  addWatcher,
  getTrendingEventIds,
  getWatchStatus as getWatchStatusFromRedis,
  recordEventView,
  removeFromTrending,
  removeWatcher,
} from './event-engagement.js';
import * as eventRepository from './event.repository.js';

import type { WatchStatus } from './event-engagement.js';
import type { EventWithVenue } from './event.repository.js';
import type { ListEventsQuery } from './event.schema.js';
import type { Redis } from '@flashsale/redis';

export interface CreateEventInput {
  venueId: string;
  name: string;
  // `?: T | undefined` -- BOTH an optional key (Zod's `.optional()` lets
  // the key be absent entirely) AND an undefined-inclusive value type
  // (exactOptionalPropertyTypes still distinguishes "absent" from
  // "present but undefined", and Zod's inferred type allows either) --
  // matches event.schema.ts's createEventSchema exactly, which is what
  // event.routes.ts passes in directly.
  description?: string | undefined;
  startTime: Date;
  endTime?: Date | undefined;
}

export async function createEvent(actorId: string, input: CreateEventInput): Promise<Event> {
  await getVenueOrThrow(input.venueId); // 404s before ever touching events table if the venue doesn't exist

  const event = await eventRepository.createEvent(input);
  await recordAuditLog({
    actorId,
    action: 'event.created',
    entityType: 'event',
    entityId: event.id,
    metadata: { name: event.name, venueId: input.venueId },
  });
  return event;
}

/**
 * Visibility rule, not just an existence check: an ADMIN can fetch an
 * event in any status; anyone else gets the SAME 404 for "doesn't exist"
 * and "exists but isn't PUBLISHED yet" -- a 403 (exists, but forbidden)
 * would leak that a draft event with this id exists at all, which is
 * exactly the kind of pre-launch information disclosure event organizers
 * care about (an unannounced event's existence, capacity, or pricing).
 *
 * The cache is bypassed ENTIRELY for an admin caller, not just skipped
 * on a miss: an admin's view must always be live (they're the one who
 * just published/edited it and needs to see that reflected immediately),
 * and a draft event's data must never be written into a cache key a
 * public, unauthenticated request could also read.
 */
export async function getEventForViewer(
  redis: Redis,
  eventId: string,
  viewerRole: string | undefined,
): Promise<EventWithVenue | SerializedEvent> {
  const isAdmin = viewerRole === 'ADMIN';

  if (isAdmin) {
    const event = await eventRepository.findEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event');
    }
    return event;
  }

  const event = await getOrSetEventCache(redis, eventId, async () => {
    const found = await eventRepository.findEventById(eventId);
    return found && found.status === 'PUBLISHED' ? found : null;
  });

  if (!event) {
    throw new NotFoundError('Event');
  }

  // Counted on EVERY view, cache hit or miss -- caching the event's data
  // is a separate concern from counting that a view happened at all; a
  // cache hit still represents a real person looking at this event.
  // recordEventView fails open internally, so this never blocks or
  // fails the response over a Redis hiccup.
  await recordEventView(redis, eventId);

  return event;
}

export async function getEventOrThrow(eventId: string): Promise<EventWithVenue> {
  const event = await eventRepository.findEventById(eventId);
  if (!event) {
    throw new NotFoundError('Event');
  }
  return event;
}

/**
 * The PUBLISHED-or-admin-else-404 visibility rule (see getEventForViewer's
 * own comment for the full "why a 404, not a 403" reasoning), extracted
 * for callers that need the GATE but not getEventForViewer's cache read
 * or view-count side effect -- e.g. the seat-availability endpoint
 * (seat.service.ts) and the live-viewer WebSocket route
 * (event-live.routes.ts), neither of which should double-count a page
 * view just because they touch the same visibility check.
 */
export async function assertEventVisibleToViewer(
  eventId: string,
  viewerRole: string | undefined,
): Promise<EventWithVenue> {
  const event = await eventRepository.findEventById(eventId);
  if (!event) {
    throw new NotFoundError('Event');
  }
  if (viewerRole !== 'ADMIN' && event.status !== 'PUBLISHED') {
    throw new NotFoundError('Event');
  }
  return event;
}

export interface ListEventsResult {
  events: (EventWithVenue | SerializedEvent)[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Public (non-admin) list results are cached (event-cache.ts's
 * getOrSetEventListCache): keyed by a hash of the normalized query plus
 * a generation counter every event write bumps, so the unbounded
 * search/filter/pagination key space never needs per-key invalidation.
 * An admin's list bypasses the cache entirely -- it can contain drafts,
 * which must never enter a key an anonymous caller could read, and an
 * admin needs their own edits reflected immediately.
 */
export async function listEvents(
  redis: Redis,
  viewerRole: string | undefined,
  query: ListEventsQuery,
): Promise<ListEventsResult> {
  const isAdmin = viewerRole === 'ADMIN';
  // A non-admin's `status` query param is silently ignored, not
  // rejected -- forcing PUBLISHED regardless of what's requested is the
  // whole point (see getEventForViewer's comment on the same principle).
  const effectiveStatus: EventStatus | undefined = isAdmin ? query.status : 'PUBLISHED';

  const filter = {
    status: effectiveStatus,
    search: query.search,
    venueId: query.venueId,
    startTimeFrom: query.startTimeFrom,
    startTimeTo: query.startTimeTo,
    page: query.page,
    pageSize: query.pageSize,
  };

  const { events, total } = isAdmin
    ? await eventRepository.listEvents(filter)
    : await getOrSetEventListCache(redis, filter, () => eventRepository.listEvents(filter));

  return { events, total, page: query.page, pageSize: query.pageSize };
}

export async function updateEvent(
  redis: Redis,
  actorId: string,
  eventId: string,
  input: {
    name?: string | undefined;
    description?: string | undefined;
    startTime?: Date | undefined;
    endTime?: Date | undefined;
  },
): Promise<Event> {
  await getEventOrThrow(eventId);
  const event = await eventRepository.updateEvent(eventId, input);
  await invalidateEventCache(redis, eventId);
  await invalidateEventListCache(redis);
  await recordAuditLog({
    actorId,
    action: 'event.updated',
    entityType: 'event',
    entityId: event.id,
    metadata: input,
  });
  return event;
}

export async function publishEvent(redis: Redis, actorId: string, eventId: string): Promise<Event> {
  const event = await getEventOrThrow(eventId);

  if (event.status !== 'DRAFT' && event.status !== 'UNPUBLISHED') {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot publish an event with status ${event.status}.`,
    );
  }

  const seatCount = await eventRepository.countSeatsForEvent(eventId);
  if (seatCount === 0) {
    throw new DomainBadRequestError(
      'EVENT_HAS_NO_SEATS',
      'Cannot publish an event with no seats. Generate seats first.',
    );
  }

  const updated = await eventRepository.updateEventStatus(eventId, 'PUBLISHED');
  // Defensive, not strictly load-bearing today: a DRAFT/UNPUBLISHED event
  // is never cached in the first place (getEventForViewer only caches a
  // PUBLISHED result), so there's normally nothing to invalidate here.
  // Kept anyway as a safety net against that invariant changing later --
  // DEL on a key that doesn't exist is a harmless no-op.
  await invalidateEventCache(redis, eventId);
  await invalidateEventListCache(redis);
  await recordAuditLog({
    actorId,
    action: 'event.published',
    entityType: 'event',
    entityId: eventId,
    metadata: { seatCount },
  });
  return updated;
}

export async function unpublishEvent(redis: Redis, actorId: string, eventId: string): Promise<Event> {
  const event = await getEventOrThrow(eventId);

  if (event.status !== 'PUBLISHED') {
    throw new DomainConflictError(
      'INVALID_STATUS_TRANSITION',
      `Cannot unpublish an event with status ${event.status}.`,
    );
  }

  const updated = await eventRepository.updateEventStatus(eventId, 'UNPUBLISHED');
  // Load-bearing here, unlike publishEvent's: this event WAS publicly
  // visible and may well be cached. Without this, a just-unpublished
  // event would stay visible to the public for up to
  // EVENT_CACHE_TTL_SECONDS after this call returns -- a real
  // correctness bug, not a performance nit.
  await invalidateEventCache(redis, eventId);
  await invalidateEventListCache(redis);
  // Symmetric with the cache invalidation above: an unpublished event
  // has no business still showing up as "trending" to public browsers.
  await removeFromTrending(redis, eventId);
  await recordAuditLog({
    actorId,
    action: 'event.unpublished',
    entityType: 'event',
    entityId: eventId,
  });
  return updated;
}

// ── Watching (Set, section 15) ────────────────────────────────────────────

/**
 * Every watch/unwatch/status call re-checks visibility via
 * getEventForViewer first (throwing the SAME 404 a direct detail fetch
 * would for a non-existent or non-public event) -- watching a draft
 * event a viewer isn't even allowed to see would be a visibility leak
 * of its own (confirming the id refers to something real). This costs
 * an extra Redis/Postgres round trip per call, which is fine: watching
 * is a low-frequency user action, not a hot read path like the cache
 * this deliberately does NOT touch.
 */
export async function watchEvent(
  redis: Redis,
  eventId: string,
  userId: string,
  viewerRole: string | undefined,
): Promise<void> {
  await getEventForViewer(redis, eventId, viewerRole);
  await addWatcher(redis, eventId, userId);
}

export async function unwatchEvent(
  redis: Redis,
  eventId: string,
  userId: string,
  viewerRole: string | undefined,
): Promise<void> {
  await getEventForViewer(redis, eventId, viewerRole);
  await removeWatcher(redis, eventId, userId);
}

export async function getWatchStatus(
  redis: Redis,
  eventId: string,
  userId: string,
  viewerRole: string | undefined,
): Promise<WatchStatus> {
  await getEventForViewer(redis, eventId, viewerRole);
  return getWatchStatusFromRedis(redis, eventId, userId);
}

// ── Trending (Sorted Set, section 16) ──────────────────────────────────────

/**
 * Joins Redis's ranking (ZREVRANGE) against Postgres for displayable
 * event data -- Redis knows the ORDER, Postgres remains the source of
 * truth for what an event actually IS. An event id present in the
 * sorted set but no longer PUBLISHED (a narrow race: unpublished between
 * the ZREVRANGE call and this fetch) is filtered out rather than shown,
 * since removeFromTrending's ZREM on unpublish is the primary
 * consistency mechanism and this filter is just a belt-and-braces
 * backstop for that race window.
 */
export async function getTrendingEvents(redis: Redis, limit: number): Promise<EventWithVenue[]> {
  const ranked = await getTrendingEventIds(redis, limit);
  if (ranked.length === 0) {
    return [];
  }

  const events = await eventRepository.findManyByIds(ranked.map((entry) => entry.eventId));
  const eventsById = new Map(events.map((event) => [event.id, event]));

  const result: EventWithVenue[] = [];
  for (const entry of ranked) {
    const event = eventsById.get(entry.eventId);
    if (event && event.status === 'PUBLISHED') {
      result.push(event);
    }
  }
  return result;
}
