import { apiFetch, apiFetchList, type ApiListResult } from '../client';
import { serverFetch, serverFetchList } from '../server';

import type { Event, EventStatus, WatchStatus } from '../types';

export interface ListEventsQuery {
  status?: EventStatus;
  search?: string;
  venueId?: string;
  startTimeFrom?: string;
  startTimeTo?: string;
  page?: number;
  pageSize?: number;
}

function toSearchParams(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, string | number | undefined>)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Server Component read -- public list, no auth. */
export function listEventsPublic(query: ListEventsQuery = {}): Promise<ApiListResult<Event>> {
  return serverFetchList<Event>(`/events${toSearchParams(query)}`);
}

/** Client read -- used from an admin page where the caller's session
 * (and therefore DRAFT/UNPUBLISHED visibility) matters. */
export function listEvents(query: ListEventsQuery = {}): Promise<ApiListResult<Event>> {
  return apiFetchList<Event>(`/events${toSearchParams(query)}`);
}

export function getTrendingEventsPublic(limit?: number): Promise<Event[]> {
  return serverFetch<Event[]>(`/events/trending${toSearchParams({ limit })}`);
}

export function getEventPublic(eventId: string): Promise<Event> {
  return serverFetch<Event>(`/events/${eventId}`);
}

export async function getEvent(eventId: string): Promise<Event> {
  const { data } = await apiFetch<Event>(`/events/${eventId}`);
  return data;
}

export interface CreateEventInput {
  venueId: string;
  name: string;
  description?: string;
  startTime: string;
  endTime?: string;
}

export async function createEvent(input: CreateEventInput): Promise<Event> {
  const { data } = await apiFetch<Event>('/events', { method: 'POST', body: input });
  return data;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
}

export async function updateEvent(eventId: string, input: UpdateEventInput): Promise<Event> {
  const { data } = await apiFetch<Event>(`/events/${eventId}`, { method: 'PATCH', body: input });
  return data;
}

export async function publishEvent(eventId: string): Promise<Event> {
  const { data } = await apiFetch<Event>(`/events/${eventId}/publish`, { method: 'POST' });
  return data;
}

export async function unpublishEvent(eventId: string): Promise<Event> {
  const { data } = await apiFetch<Event>(`/events/${eventId}/unpublish`, { method: 'POST' });
  return data;
}

export async function watchEvent(eventId: string): Promise<void> {
  await apiFetch(`/events/${eventId}/watch`, { method: 'POST' });
}

export async function unwatchEvent(eventId: string): Promise<void> {
  await apiFetch(`/events/${eventId}/watch`, { method: 'DELETE' });
}

export async function getWatchStatus(eventId: string): Promise<WatchStatus> {
  const { data } = await apiFetch<WatchStatus>(`/events/${eventId}/watch`);
  return data;
}
