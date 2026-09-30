import { prisma, writeOutboxEvent, type Reservation, type ReservationItem, type Seat } from '@flashsale/database';

export type ReservationWithItems = Reservation & {
  items: (ReservationItem & { seat: Seat })[];
};

const withItemsAndSeat = {
  items: { include: { seat: true } },
} as const;

/**
 * The interactive (callback) form of `$transaction`, not the array form --
 * deliberately, because the second statement (creating each
 * ReservationItem) needs the FIRST statement's generated `reservation.id`,
 * which the array form has no way to reference. Everything inside this
 * callback commits or rolls back together: if `reservationItem.createMany`
 * hits the partial unique index (reservation.service.ts's caller catches
 * Prisma error P2002), Postgres rolls back the Reservation row too -- there
 * is no window where a Reservation can exist with zero items, not even
 * across a crash mid-transaction.
 */
export async function createReservationWithItems(
  userId: string,
  eventId: string,
  seatIds: string[],
  expiresAt: Date,
): Promise<ReservationWithItems> {
  const reservationId = await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.create({ data: { userId, eventId, expiresAt } });

    await tx.reservationItem.createMany({
      data: seatIds.map((seatId) => ({ reservationId: reservation.id, seatId })),
    });

    // Denormalized display state (schema.prisma's SeatStatus comment) --
    // the correctness invariant is entirely the createMany above; this
    // update can never itself be the reason a claim fails, since it has
    // no unique constraint of its own to violate.
    await tx.seat.updateMany({
      where: { id: { in: seatIds } },
      data: { status: 'RESERVED' },
    });

    // Same transaction as the writes above (Phase 10, section 8) -- if
    // reservationItem.createMany above rolls back on a unique-index hit,
    // this outbox row is rolled back with it. No world where a
    // reservation exists but "reservation.created" never gets announced,
    // and no world where the event exists for a claim that failed.
    await writeOutboxEvent(tx, {
      aggregateType: 'reservation',
      aggregateId: reservation.id,
      eventType: 'reservation.created',
      payload: { reservationId: reservation.id, userId, eventId, seatIds },
    });

    return reservation.id;
  });

  return prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: withItemsAndSeat });
}

export function findReservationById(id: string): Promise<ReservationWithItems | null> {
  return prisma.reservation.findUnique({ where: { id }, include: withItemsAndSeat });
}

export function listReservationsForUser(userId: string): Promise<ReservationWithItems[]> {
  return prisma.reservation.findMany({
    where: { userId },
    include: withItemsAndSeat,
    orderBy: { createdAt: 'desc' },
  });
}
