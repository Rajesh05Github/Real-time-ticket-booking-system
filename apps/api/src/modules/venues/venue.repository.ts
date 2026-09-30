import { prisma, type Section, type Venue } from '@flashsale/database';

export function createVenue(data: {
  name: string;
  // `?: T | undefined`: matches the shape Zod's `.optional()` actually
  // infers (venue.schema.ts) -- an optional key AND an undefined-
  // inclusive value, both at once. See event.repository.ts for the
  // fuller explanation of this exactOptionalPropertyTypes pattern.
  address?: string | undefined;
  city?: string | undefined;
}): Promise<Venue> {
  return prisma.venue.create({
    data: {
      name: data.name,
      // Conditionally spread, not assigned directly: Prisma's generated
      // input type marks these optional (`field?: string | null`), and
      // exactOptionalPropertyTypes treats "key present with value
      // undefined" as a different, disallowed shape from "key omitted".
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.city !== undefined ? { city: data.city } : {}),
    },
  });
}

export function findVenueById(id: string): Promise<Venue | null> {
  return prisma.venue.findUnique({ where: { id } });
}

export function listVenues(): Promise<Venue[]> {
  return prisma.venue.findMany({ orderBy: { name: 'asc' } });
}

export function createSection(venueId: string, name: string): Promise<Section> {
  return prisma.section.create({ data: { venueId, name } });
}

export function listSectionsByVenue(venueId: string): Promise<Section[]> {
  return prisma.section.findMany({ where: { venueId }, orderBy: { name: 'asc' } });
}

export function findSectionById(id: string): Promise<Section | null> {
  return prisma.section.findUnique({ where: { id } });
}
