/**
 * Cross-cutting auth constants -- shared between apps/api (enforces them)
 * and anywhere else that needs to display them (e.g. web showing "code
 * expires in 5 minutes").
 */

/** Redis TTL on otp:user:{userId} -- reset on every send/resend. */
export const OTP_TTL_SECONDS = 300;

/**
 * After this many wrong guesses, the OTP is invalidated outright (deleted
 * from Redis, forcing a fresh resend) rather than just left to expire
 * naturally. Section 0's correction: without this, a 6-digit OTP is
 * brute-forceable well within its 5-minute TTL by an attacker making
 * requests faster than the API's general rate limiter alone would catch.
 */
export const OTP_MAX_ATTEMPTS = 5;

export const OTP_LENGTH = 6;

/** Minimum time between OTP resend requests for the same user. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Fixed session lifetime (7 days). This is an ABSOLUTE expiry set once at
 * login, not an idle timeout that slides forward on activity -- see
 * docs/auth-flow.md for why sliding expiration was deliberately kept out
 * of Phase 4's scope.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * How stale `lastActivityAt` must be before the session hook bothers
 * writing a refreshed value back to Redis. Without this, an authenticated
 * user polling the API would trigger a Redis write on every single
 * request just to update a timestamp nothing consumes at that
 * granularity (Phase 0 correction #16).
 */
export const SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS = 60;

export const SESSION_COOKIE_NAME = 'flashsale_sid';

/**
 * Phase 20's CSRF defense-in-depth (docs/auth-flow.md flagged this as
 * deferred since Phase 4: "CSRF protection beyond SameSite=Lax"). A
 * signed double-submit cookie -- NOT HttpOnly, deliberately: the
 * frontend JS must be able to read this value and echo it back in
 * `CSRF_HEADER_NAME` on every state-changing request. An attacker's
 * cross-site page can't read it (same-origin policy) and can't forge a
 * valid one either (it's an HMAC of the session id, keyed on
 * COOKIE_SECRET, which only this server knows) -- see
 * apps/api/src/plugins/csrf.ts.
 */
export const CSRF_COOKIE_NAME = 'flashsale_csrf';

/** Header the frontend echoes CSRF_COOKIE_NAME's value back in. */
export const CSRF_HEADER_NAME = 'x-csrf-token';
