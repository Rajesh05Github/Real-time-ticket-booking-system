/**
 * `NEXT_PUBLIC_API_URL` is an ORIGIN ONLY (e.g. `https://localhost:8443`,
 * or empty for same-origin) -- this module is the one place that owns
 * appending `/api/v1`. See docker-compose.yml's own comment on why this
 * convention matters: the build-arg value and .env.example's host-run
 * value used to disagree on whether `/api` was baked in, which is
 * exactly the kind of inconsistency that silently breaks every request
 * the moment someone copies the "wrong" one.
 */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * Where SERVER-side code (Server Components via `serverFetch`) reaches the
 * API. A same-origin deployment builds the browser bundle with an empty
 * NEXT_PUBLIC_API_URL (relative URLs), but Node's fetch has no "current
 * origin" to resolve a relative URL against -- so the server needs an
 * absolute address of its own. `API_INTERNAL_URL` is read at RUNTIME
 * (not a NEXT_PUBLIC_ var, so it is never inlined into the bundle) and
 * typically points at the API's private address, e.g. the Azure
 * Container Apps internal FQDN, skipping the public gateway entirely.
 */
function serverApiOrigin(): string {
  return process.env.API_INTERNAL_URL ?? API_ORIGIN;
}

export function apiUrl(path: string): string {
  const origin = typeof window === 'undefined' ? serverApiOrigin() : API_ORIGIN;
  return `${origin}/api/v1${path}`;
}

/** Same origin, ws:// or wss:// instead of http(s):// -- for the raw
 * WebSocket live endpoint. Client-only: falls back to `window.location`
 * when API_ORIGIN is empty (same-origin deployment, e.g. behind Nginx or
 * the Azure gateway). */
export function wsUrl(path: string): string {
  if (API_ORIGIN) {
    const httpUrl = new URL(`${API_ORIGIN}/api/v1${path}`);
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return httpUrl.toString();
  }
  if (typeof window === 'undefined') {
    throw new Error('wsUrl() with no NEXT_PUBLIC_API_URL can only be called in the browser.');
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/v1${path}`;
}
