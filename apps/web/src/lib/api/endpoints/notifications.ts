import { apiFetch } from '../client';

import type { NotificationItem } from '../types';

export async function listNotifications(): Promise<NotificationItem[]> {
  const { data } = await apiFetch<NotificationItem[]>('/notifications');
  return data;
}
