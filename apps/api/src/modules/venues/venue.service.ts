import { Prisma, recordAuditLog, type Section, type Venue } from '@flashsale/database';
import { ConflictError, NotFoundError } from '@flashsale/shared';

import * as venueRepository from './venue.repository.js';

export async function createVenue(
  actorId: string,
  input: { name: string; address?: string | undefined; city?: string | undefined },
): Promise<Venue> {
  const venue = await venueRepository.createVenue(input);
  await recordAuditLog({
    actorId,
    action: 'venue.created',
    entityType: 'venue',
    entityId: venue.id,
    metadata: { name: venue.name },
  });
  return venue;
}

export const listVenues = venueRepository.listVenues;

export async function getVenueOrThrow(venueId: string): Promise<Venue> {
  const venue = await venueRepository.findVenueById(venueId);
  if (!venue) {
    throw new NotFoundError('Venue');
  }
  return venue;
}

export async function createSection(
  actorId: string,
  venueId: string,
  name: string,
): Promise<Section> {
  await getVenueOrThrow(venueId);

  try {
    const section = await venueRepository.createSection(venueId, name);
    await recordAuditLog({
      actorId,
      action: 'section.created',
      entityType: 'section',
      entityId: section.id,
      metadata: { venueId, name },
    });
    return section;
  } catch (err) {
    // P2002: Prisma's unique-constraint-violation code -- here that's
    // sections_venue_id_name_key (schema.prisma's @@unique([venueId,
    // name])). Translating it into a domain-meaningful 409 at the
    // service layer means the route handler never needs to know Prisma
    // error codes exist.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`A section named "${name}" already exists at this venue.`);
    }
    throw err;
  }
}

export const listSectionsByVenue = venueRepository.listSectionsByVenue;
