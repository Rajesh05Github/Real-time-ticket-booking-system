import { apiFetch } from '../client';
import { serverFetch } from '../server';

import type {
  GenerateSeatsResult,
  Seat,
  SeatAvailability,
  SeatGenerationAssignment,
  SeatGenerationJobStatus,
} from '../types';

/** Server Component read -- public, used on the event detail page. */
export function getSeatAvailabilityPublic(eventId: string): Promise<SeatAvailability> {
  return serverFetch<SeatAvailability>(`/events/${eventId}/seats/availability`);
}

export async function getSeatAvailability(eventId: string): Promise<SeatAvailability> {
  const { data } = await apiFetch<SeatAvailability>(`/events/${eventId}/seats/availability`);
  return data;
}

export async function generateSeats(
  eventId: string,
  assignments: SeatGenerationAssignment[],
): Promise<GenerateSeatsResult> {
  const { data } = await apiFetch<GenerateSeatsResult>(`/events/${eventId}/seats`, {
    method: 'POST',
    body: { assignments },
  });
  return data;
}

export async function listSeatsAdmin(eventId: string): Promise<Seat[]> {
  const { data } = await apiFetch<Seat[]>(`/events/${eventId}/seats`);
  return data;
}

export async function getSeatGenerationJob(eventId: string, jobId: string): Promise<SeatGenerationJobStatus> {
  const { data } = await apiFetch<SeatGenerationJobStatus>(
    `/events/${eventId}/seats/generation-jobs/${jobId}`,
  );
  return data;
}
