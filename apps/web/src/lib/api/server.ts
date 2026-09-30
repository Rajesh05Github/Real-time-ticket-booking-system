import { apiUrl } from './config';
import { ApiError } from './errors';

import type { ApiFailure, ApiSuccess } from '@flashsale/shared';

/**
 * For Server Components ONLY, and PUBLIC reads only -- no cookies
 * forwarded, no CSRF, no idempotency. next.config.ts's own comment
 * prefers Server Component data fetching where it pays off (a good first
 * paint on public, indexable content); this is exactly that path for
 * `/events`, `/events/:id`, `/events/trending`,
 * `/events/:id/seats/availability`.
 *
 * Deliberately does NOT forward the session cookie: doing so would make
 * every such page dynamic-per-user and split the auth story across two
 * runtimes for no benefit, since every AUTHENTICATED surface in this app
 * (reservations, checkout, admin) is inherently interactive anyway and
 * uses `client.ts`'s `apiFetch` instead. See lib/auth's own comment on
 * why route protection is a client concern here, not middleware.ts.
 */
export async function serverFetch<T>(path: string, options: { revalidate?: number } = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    next: { revalidate: options.revalidate ?? 0 },
  });

  const text = await response.text();
  let body: ApiSuccess<T> | ApiFailure | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as ApiSuccess<T> | ApiFailure;
    } catch {
      throw new ApiError('BAD_GATEWAY', response.status, 'The server returned an unexpected response.');
    }
  }

  if (body && body.success) {
    return body.data;
  }
  if (body && !body.success) {
    throw new ApiError(body.error.code, response.status, body.error.message, body.error.details, body.requestId);
  }
  throw new ApiError('UNKNOWN_ERROR', response.status, `Request failed with status ${response.status}.`);
}

export async function serverFetchList<T>(
  path: string,
  options: { revalidate?: number } = {},
): Promise<{ items: T[]; page: number; pageSize: number; total: number }> {
  const response = await fetch(apiUrl(path), { next: { revalidate: options.revalidate ?? 0 } });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as ApiSuccess<T[]> | ApiFailure) : undefined;

  if (body && body.success) {
    return {
      items: body.data,
      page: body.meta?.page ?? 1,
      pageSize: body.meta?.pageSize ?? body.data.length,
      total: body.meta?.total ?? body.data.length,
    };
  }
  if (body && !body.success) {
    throw new ApiError(body.error.code, response.status, body.error.message, body.error.details, body.requestId);
  }
  throw new ApiError('UNKNOWN_ERROR', response.status, `Request failed with status ${response.status}.`);
}
