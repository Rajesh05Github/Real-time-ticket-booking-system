import { TRENDING_EVENTS_DEFAULT_LIMIT, TRENDING_EVENTS_MAX_LIMIT } from '@flashsale/shared';
import { z } from 'zod';

export const createEventSchema = z
  .object({
    venueId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000).optional(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date().optional(),
  })
  .refine((data) => !data.endTime || data.endTime > data.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });
export type CreateEventBody = z.infer<typeof createEventSchema>;

// venueId and status are deliberately absent: venueId is immutable after
// creation (changing it would orphan seats' sectionId references, since
// sections belong to whichever venue the event was originally created
// against), and status only changes through the explicit publish/
// unpublish actions below, never a raw field write.
export const updateEventSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    startTime: z.coerce.date().optional(),
    endTime: z.coerce.date().optional(),
  })
  .refine((data) => !data.endTime || !data.startTime || data.endTime > data.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });
export type UpdateEventBody = z.infer<typeof updateEventSchema>;

export const eventIdParamsSchema = z.object({
  eventId: z.string().uuid(),
});

export const listEventsQuerySchema = z.object({
  // Only meaningful for an ADMIN caller -- see event.service.ts's
  // listEvents, which forces PUBLISHED-only for everyone else regardless
  // of what's passed here.
  status: z.enum(['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'CANCELLED']).optional(),

  // Simple case-insensitive substring match on name/description --
  // deliberately not full-text search (Postgres tsvector, a dedicated
  // search engine). At this project's scale a `contains` filter is
  // enough; reaching for real search infrastructure before there's a
  // demonstrated need would be exactly the premature complexity section
  // 58 warns against.
  search: z.string().trim().min(1).max(200).optional(),
  venueId: z.string().uuid().optional(),
  startTimeFrom: z.coerce.date().optional(),
  startTimeTo: z.coerce.date().optional(),

  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

export const trendingQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(TRENDING_EVENTS_MAX_LIMIT)
    .default(TRENDING_EVENTS_DEFAULT_LIMIT),
});
