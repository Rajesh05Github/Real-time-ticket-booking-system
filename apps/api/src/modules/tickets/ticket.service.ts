import { ForbiddenError, NotFoundError } from '@flashsale/shared';

import * as ticketRepository from './ticket.repository.js';

import type { TicketWithContext } from './ticket.repository.js';

export async function getTicketForUser(
  ticketId: string,
  userId: string,
  userRole: string,
): Promise<TicketWithContext> {
  const ticket = await ticketRepository.findTicketById(ticketId);
  if (!ticket) {
    throw new NotFoundError('Ticket');
  }
  if (ticket.userId !== userId && userRole !== 'ADMIN') {
    throw new ForbiddenError('You do not have access to this ticket.');
  }
  return ticket;
}

export function listMyTickets(userId: string): Promise<TicketWithContext[]> {
  return ticketRepository.listTicketsForUser(userId);
}
