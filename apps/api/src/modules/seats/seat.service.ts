import { recordAuditLog, type Seat } from '@flashsale/database';
import {
  buildSeatRows,
  DomainBadRequestError,
  JOB_NAMES,
  SEAT_GENERATION_SYNC_LIMIT,
  type SeatGenerationAssignment,
} from '@flashsale/shared';

import { seatGenerationQueue } from '../../queues/seat-generation-queue.js';
import { assertEventVisibleToViewer, getEventOrThrow } from '../events/event.service.js';
import * as venueRepository from '../venues/venue.repository.js';

import * as seatRepository from './seat.repository.js';

import type { SeatAvailabilityRow } from './seat.repository.js';

export type GenerateSeatsResult =
  | { mode: 'sync'; seats: Seat[] }
  | { mode: 'async'; jobId: string };

/**
 * Validates every assignment's section actually belongs to the event's
 * own venue BEFORE creating anything -- without this, a typo'd sectionId
 * from a different venue would silently create seats an admin can never
 * see in that venue's normal management view, discovered only much
 * later as "missing" seats.
 */
async function validateAssignments(
  eventVenueId: string,
  assignments: SeatGenerationAssignment[],
): Promise<void> {
  for (const assignment of assignments) {
    const section = await venueRepository.findSectionById(assignment.sectionId);
    if (!section) {
      throw new DomainBadRequestError('SECTION_NOT_FOUND', `Section ${assignment.sectionId} does not exist.`);
    }
    if (section.venueId !== eventVenueId) {
      throw new DomainBadRequestError(
        'SECTION_VENUE_MISMATCH',
        `Section ${assignment.sectionId} does not belong to this event's venue.`,
      );
    }
  }
}

export async function generateSeats(
  actorId: string,
  eventId: string,
  assignments: SeatGenerationAssignment[],
): Promise<GenerateSeatsResult> {
  const event = await getEventOrThrow(eventId);
  await validateAssignments(event.venueId, assignments);

  const totalSeats = assignments.reduce((sum, a) => sum + a.seatCount, 0);

  if (totalSeats < SEAT_GENERATION_SYNC_LIMIT) {
    const rows = buildSeatRows(eventId, assignments);
    const { count } = await seatRepository.createSeatsMany(rows);
    const seats = await seatRepository.listSeatsForEvent(eventId);
    await recordAuditLog({
      actorId,
      action: 'seats.generated',
      entityType: 'event',
      entityId: eventId,
      metadata: { count, mode: 'sync' },
    });
    return { mode: 'sync', seats };
  }

  // Above the threshold: hand off to apps/worker rather than hold this
  // request's connection open for a potentially multi-minute bulk
  // insert. See docs/admin-flow.md for the full reasoning and
  // packages/shared's SEAT_GENERATION_SYNC_LIMIT for the threshold.
  const job = await seatGenerationQueue.add(JOB_NAMES.GENERATE_SEATS, {
    eventId,
    actorId,
    assignments,
  });

  if (!job.id) {
    // BullMQ always assigns an id on a successful add() unless a custom
    // jobId was requested and collided -- this branch exists only so the
    // return type doesn't have to carry `string | undefined` everywhere
    // downstream for a case that isn't reachable in practice here.
    throw new Error('BullMQ did not assign a job id');
  }

  return { mode: 'async', jobId: job.id };
}

export const listSeatsForEvent = seatRepository.listSeatsForEvent;

export interface SeatAvailabilitySeat {
  id: string;
  seatCode: string;
  priceMinor: number;
  currency: string;
  status: SeatAvailabilityRow['status'];
}

export interface SeatAvailabilitySection {
  id: string;
  name: string;
  seatCount: number;
  availableCount: number;
  minPriceMinor: number;
  maxPriceMinor: number;
  seats: SeatAvailabilitySeat[];
}

export interface SeatAvailability {
  eventId: string;
  venue: { id: string; name: string; city: string | null };
  totalSeats: number;
  availableSeats: number;
  /** `null` if sections disagree on currency -- an edge case this project
   * allows (nothing stops an admin generating two assignments with
   * different currencies), so the UI can't assume one currency exists
   * event-wide and must fall back to each seat's own `currency`. */
  currency: string | null;
  sections: SeatAvailabilitySection[];
}

/**
 * Splits a seat code into its alphabetic prefix and trailing numeric
 * suffix (e.g. "A10" -> ["A", 10]) so seats sort A1, A2, ... A10 instead
 * of the lexicographic A1, A10, A2 a plain string sort produces --
 * correct for a table (the admin view) but visibly wrong for a seat MAP,
 * where row order is what a real customer expects to recognize. A code
 * with no trailing digits (or an unexpected format) sorts by the whole
 * string with numeric part 0, which degrades to plain alphabetical --
 * never throws on a seat code this project didn't generate itself.
 */
function compareSeatCodes(a: string, b: string): number {
  const parse = (code: string): [string, number] => {
    const match = /^(.*?)(\d+)$/.exec(code);
    return match ? [match[1] as string, Number(match[2])] : [code, 0];
  };
  const [prefixA, numA] = parse(a);
  const [prefixB, numB] = parse(b);
  if (prefixA !== prefixB) {
    return prefixA < prefixB ? -1 : 1;
  }
  return numA - numB;
}

/**
 * The read side of the seat map (Phase 22's frontend build): PUBLIC (or
 * admin-preview) seat availability, grouped by section with aggregate
 * counts/price ranges so the client doesn't have to derive them from
 * potentially thousands of rows. Deliberately UNCACHED, unlike
 * `getEventForViewer`'s event-detail cache -- seat status is the single
 * most volatile piece of state in this whole system (Phase 9's Redis
 * lock + Postgres partial-unique-index exist specifically because seats
 * get claimed and released constantly), and a stale "AVAILABLE" here
 * doesn't just look wrong, it becomes a guaranteed `SEAT_NOT_AVAILABLE`
 * the moment the customer clicks it.
 */
export async function getSeatAvailability(
  eventId: string,
  viewerRole: string | undefined,
): Promise<SeatAvailability> {
  const event = await assertEventVisibleToViewer(eventId, viewerRole);
  const rows = await seatRepository.listSeatAvailabilityForEvent(eventId);

  const sectionsById = new Map<string, SeatAvailabilitySection>();
  let availableSeats = 0;
  let currency: string | null | undefined; // undefined = not yet seen; null = disagreement seen

  for (const row of rows) {
    let section = sectionsById.get(row.section.id);
    if (!section) {
      section = {
        id: row.section.id,
        name: row.section.name,
        seatCount: 0,
        availableCount: 0,
        minPriceMinor: row.priceMinor,
        maxPriceMinor: row.priceMinor,
        seats: [],
      };
      sectionsById.set(row.section.id, section);
    }

    section.seatCount += 1;
    section.minPriceMinor = Math.min(section.minPriceMinor, row.priceMinor);
    section.maxPriceMinor = Math.max(section.maxPriceMinor, row.priceMinor);
    if (row.status === 'AVAILABLE') {
      section.availableCount += 1;
      availableSeats += 1;
    }
    section.seats.push({
      id: row.id,
      seatCode: row.seatCode,
      priceMinor: row.priceMinor,
      currency: row.currency,
      status: row.status,
    });

    if (currency === undefined) {
      currency = row.currency;
    } else if (currency !== null && currency !== row.currency) {
      currency = null;
    }
  }

  const sections = [...sectionsById.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const section of sections) {
    section.seats.sort((a, b) => compareSeatCodes(a.seatCode, b.seatCode));
  }

  return {
    eventId,
    venue: { id: event.venue.id, name: event.venue.name, city: event.venue.city },
    totalSeats: rows.length,
    availableSeats,
    currency: currency ?? null,
    sections,
  };
}
