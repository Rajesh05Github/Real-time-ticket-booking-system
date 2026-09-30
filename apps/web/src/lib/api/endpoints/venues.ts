import { apiFetch } from '../client';

import type { Section, Venue } from '../types';

export async function listVenues(): Promise<Venue[]> {
  const { data } = await apiFetch<Venue[]>('/venues');
  return data;
}

export async function createVenue(input: { name: string; address?: string; city?: string }): Promise<Venue> {
  const { data } = await apiFetch<Venue>('/venues', { method: 'POST', body: input });
  return data;
}

export async function listSections(venueId: string): Promise<Section[]> {
  const { data } = await apiFetch<Section[]>(`/venues/${venueId}/sections`);
  return data;
}

export async function createSection(venueId: string, name: string): Promise<Section> {
  const { data } = await apiFetch<Section>(`/venues/${venueId}/sections`, {
    method: 'POST',
    body: { name },
  });
  return data;
}
