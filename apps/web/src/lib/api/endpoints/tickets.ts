import { apiFetch } from '../client';

import type { TicketWithContext } from '../types';

export async function listTickets(): Promise<TicketWithContext[]> {
  const { data } = await apiFetch<TicketWithContext[]>('/tickets');
  return data;
}

export async function getTicket(ticketId: string): Promise<TicketWithContext> {
  const { data } = await apiFetch<TicketWithContext>(`/tickets/${ticketId}`);
  return data;
}
