import { apiFetch } from '../client';

import type { AnalyticsSummary } from '../types';

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const { data } = await apiFetch<AnalyticsSummary>('/analytics/summary');
  return data;
}
