import { apiFetch } from '../client';

import type { Reservation } from '../types';

export async function createReservation(
  idempotencyKey: string,
  eventId: string,
  seatIds: string[],
): Promise<Reservation> {
  const { data } = await apiFetch<Reservation>('/reservations', {
    method: 'POST',
    body: { eventId, seatIds },
    idempotencyKey,
  });
  return data;
}

export async function listReservations(): Promise<Reservation[]> {
  const { data } = await apiFetch<Reservation[]>('/reservations');
  return data;
}

export async function getReservation(reservationId: string): Promise<Reservation> {
  const { data } = await apiFetch<Reservation>(`/reservations/${reservationId}`);
  return data;
}

export async function cancelReservation(reservationId: string): Promise<void> {
  await apiFetch(`/reservations/${reservationId}`, { method: 'DELETE' });
}
