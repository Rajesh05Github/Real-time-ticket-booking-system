import { CSRF_HEADER_NAME } from '@flashsale/shared';

import { apiUrl } from './config';
import { readCsrfToken } from './csrf';
import { ApiError } from './errors';

import type { ApiFailure, ApiSuccess } from '@flashsale/shared';

/**
 * The literal `apps/api/src/plugins/idempotency.ts` reads -- deliberately
 * NOT exported from @flashsale/shared (verified: it's a module-private
 * const there). Lowercase is fine regardless; HTTP header names are
 * case-insensitive.
 */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiListResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The one function every endpoint module builds on. Always
 * `credentials: 'include'` (session cookie) and `cache: 'no-store'` (an
 * authenticated response must never land in Next's fetch cache) --
 * this is the CLIENT-side client; `server.ts`'s `serverFetch` is the
 * separate, cookie-free path for Server Components reading public data.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<{ data: T; meta?: ApiSuccess<T>['meta'] }> {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (!SAFE_METHODS.has(method)) {
    // Attach the header ONLY when a token actually exists -- do NOT
    // throw when it's missing. Several mutating routes have no session
    // yet at all (register, login, resend-otp, verify-otp) and were
    // never going to carry a CSRF cookie in the first place; the
    // server's own `requireAuth` is what decides whether a given route
    // needs a session (and therefore CSRF) at all; this client's job is
    // only to cooperate by echoing the token back WHEN one exists, never
    // to pre-emptively reject a request the server might not have
    // required it for. A real `requireAuth`-protected route with a
    // genuinely missing/expired session will still correctly fail with
    // the server's own 401/403, just one round trip later instead of
    // zero -- the honest cost of not assuming route-by-route which
    // endpoints need a session.
    const csrfToken = readCsrfToken();
    if (csrfToken) {
      headers[CSRF_HEADER_NAME] = csrfToken;
    }
  }

  if (options.idempotencyKey) {
    headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new ApiError('NETWORK_ERROR', 0, 'Could not reach the server.');
  }

  if (response.status === 204) {
    return { data: undefined as T };
  }

  const text = await response.text();
  let body: ApiSuccess<T> | ApiFailure | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as ApiSuccess<T> | ApiFailure;
    } catch {
      throw new ApiError(
        'BAD_GATEWAY',
        response.status,
        'The server returned an unexpected response.',
      );
    }
  }

  if (body && body.success) {
    return { data: body.data, meta: body.meta };
  }
  if (body && !body.success) {
    throw new ApiError(body.error.code, response.status, body.error.message, body.error.details, body.requestId);
  }
  throw new ApiError('UNKNOWN_ERROR', response.status, `Request failed with status ${response.status}.`);
}

export async function apiFetchList<T>(path: string, options: ApiFetchOptions = {}): Promise<ApiListResult<T>> {
  const { data, meta } = await apiFetch<T[]>(path, options);
  return {
    items: data,
    page: meta?.page ?? 1,
    pageSize: meta?.pageSize ?? data.length,
    total: meta?.total ?? data.length,
  };
}
