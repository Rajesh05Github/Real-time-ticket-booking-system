import { CSRF_COOKIE_NAME } from '@flashsale/shared';

/**
 * Two cookie facts worth writing down because they look like bugs
 * otherwise:
 *
 * 1. Cookies ignore PORT. `localhost:3000` (web) can read a cookie the
 *    API set for `localhost:4000` (or through Nginx, both on 8443) as
 *    long as the HOSTNAME matches -- that's what makes local dev's
 *    double-submit work at all.
 * 2. The corollary is the real constraint: deploy web and API on
 *    DIFFERENT hostnames (www.x.com vs api.x.com) and this cookie
 *    becomes unreadable from the web origin, and the session cookie's
 *    SameSite=Lax stops being sent on cross-site POSTs. The same-origin
 *    Nginx topology this project already runs (infra/nginx/nginx.conf)
 *    is a HARD requirement for this auth model, not a convenience.
 */
export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE_NAME.length + 1)) : null;
}
