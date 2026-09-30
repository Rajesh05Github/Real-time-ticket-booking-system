import { prisma, type Prisma, type Seat } from '@flashsale/database';

import type { SeatRow } from '@flashsale/shared';

// Explicit `select`, not a bare `findMany` -- see listSeatAvailabilityForEvent's
// own comment for why this matters specifically for a PUBLIC read path.
const seatAvailabilitySelect = {
  id: true,
  seatCode: true,
  priceMinor: true,
  currency: true,
  status: true,
  section: { select: { id: true, name: true } },
} satisfies Prisma.SeatSelect;

export type SeatAvailabilityRow = Prisma.SeatGetPayload<{ select: typeof seatAvailabilitySelect }>;

/**
 * A single `createMany` call is already one atomic SQL statement -- no
 * `$transaction` wrapper needed for the synchronous path, since it's
 * only ever called once per request (never multiple chunks; chunking
 * only happens on the background-job path in apps/worker, for requests
 * too large to be synchronous in the first place).
 */
export function createSeatsMany(rows: SeatRow[]): Promise<{ count: number }> {
  return prisma.seat.createMany({ data: rows });
}

export function listSeatsForEvent(eventId: string): Promise<Seat[]> {
  return prisma.seat.findMany({
    where: { eventId },
    orderBy: [{ sectionId: 'asc' }, { seatCode: 'asc' }],
  });
}

/**
 * The PUBLIC read of a seat: an explicit `select` (id, seatCode,
 * priceMinor, currency, status, section name) rather than a bare
 * `findMany`, unlike `listSeatsForEvent` above (the ADMIN read, which
 * returns raw `Seat` rows). This is the whole reason this is a SEPARATE
 * function rather than the same query reused: if `Seat` ever grows a
 * column that shouldn't be public (an internal note, a hold token), an
 * explicit select here means it does NOT silently start leaking onto
 * this endpoint just because `listSeatsForEvent` grew a new field --
 * see seat.routes.ts's `/availability` route.
 *
 * Ordered by section name, then seat code -- but NOT by a plain
 * `orderBy: { seatCode: 'asc' }` alone, which is lexicographic and would
 * put "A10" before "A2". seat.service.ts's `getSeatAvailability` applies
 * a numeric-suffix-aware sort on top of this for that reason -- see its
 * own comment.
 */
export function listSeatAvailabilityForEvent(eventId: string): Promise<SeatAvailabilityRow[]> {
  return prisma.seat.findMany({
    where: { eventId },
    select: seatAvailabilitySelect,
    orderBy: [{ section: { name: 'asc' } }, { seatCode: 'asc' }],
  });
}

/**
 * Scoped by eventId, not just id -- a seatId that's real but belongs to a
 * DIFFERENT event must be rejected the same way a nonexistent one is
 * (reservation.service.ts checks `seats.length !== seatIds.length`), not
 * silently accepted just because the id happens to exist somewhere.
 */
export function findSeatsByIds(eventId: string, seatIds: string[]): Promise<Seat[]> {
  return prisma.seat.findMany({ where: { eventId, id: { in: seatIds } } });
}
