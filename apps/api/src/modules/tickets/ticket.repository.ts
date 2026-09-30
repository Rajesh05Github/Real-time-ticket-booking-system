import { prisma, type Prisma, type Ticket } from '@flashsale/database';

import { generateTicketNumber } from './ticket-number.js';

export interface ReservationItemForIssuance {
  id: string;
  seatId: string;
}

/**
 * Issues one Ticket per ACTIVE ReservationItem, as part of an
 * ALREADY-OPEN transaction -- called from order.repository.ts's
 * `applyPaymentSucceeded`, never on its own. Same reasoning as
 * `writeOutboxEvent`: passing the caller's `tx` (not a fresh `prisma`
 * call) is what makes "payment succeeded" and "tickets exist" atomic --
 * there is no world where an Order is PAID with zero tickets, and no
 * world where a ticket exists for a payment that ultimately rolled back.
 *
 * A plain `createMany`, not one `create` per item wrapped in its own
 * try/catch: nothing about issuing multiple tickets for the SAME order
 * needs per-item error isolation the way, say, the outbox publisher's
 * per-event try/catch does (Phase 10) -- if any one of these inserts
 * were to fail (in practice: the partial unique index rejecting a
 * reservation_item that somehow already has an ISSUED ticket, which
 * `applyPaymentSucceeded`'s own PENDING-payment guard should make
 * unreachable), the WHOLE payment-success transaction should roll back
 * rather than leave an order PAID with a partial set of tickets.
 */
export async function issueTicketsForOrder(
  tx: Prisma.TransactionClient,
  order: { id: string; userId: string; eventId: string },
  items: ReservationItemForIssuance[],
): Promise<void> {
  await tx.ticket.createMany({
    data: items.map((item) => ({
      ticketNumber: generateTicketNumber(),
      userId: order.userId,
      eventId: order.eventId,
      orderId: order.id,
      reservationItemId: item.id,
      seatId: item.seatId,
    })),
  });
}

const withEventAndSeat = {
  // Nested `venue` select, not `event: true` -- the web client's
  // TicketWithContext type expects `event.venue` (same EventWithVenue
  // shape event.repository.ts already produces for direct event reads)
  // to render the venue name/city on a ticket without a second request.
  event: { include: { venue: { select: { id: true, name: true, city: true } } } },
  seat: true,
} as const;

export type TicketWithContext = Prisma.TicketGetPayload<{ include: typeof withEventAndSeat }>;

export function findTicketById(id: string): Promise<TicketWithContext | null> {
  return prisma.ticket.findUnique({ where: { id }, include: withEventAndSeat });
}

export function listTicketsForUser(userId: string): Promise<TicketWithContext[]> {
  return prisma.ticket.findMany({
    where: { userId },
    include: withEventAndSeat,
    orderBy: { issuedAt: 'desc' },
  });
}

export function listTicketsForOrder(orderId: string): Promise<Ticket[]> {
  return prisma.ticket.findMany({ where: { orderId }, orderBy: { issuedAt: 'asc' } });
}
