/**
 * Per-endpoint rate limit budgets (section 20). Each protected route gets
 * its own bucket name and (limit, windowSeconds) pair, chosen per-endpoint
 * rather than one global number, because these routes have very different
 * legitimate usage patterns: a real user logs in occasionally but might
 * mistype their password a few times in a row, while resend-otp has almost
 * no legitimate reason to be called more than once or twice a minute.
 */
export interface RateLimitBucket {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/** Brute-force login-guessing guard, keyed by request IP. */
export const RATE_LIMIT_LOGIN: RateLimitBucket = {
  bucket: 'login',
  limit: 10,
  windowSeconds: 60,
};

/** Mass-account-creation guard, keyed by request IP. */
export const RATE_LIMIT_REGISTER: RateLimitBucket = {
  bucket: 'register',
  limit: 5,
  windowSeconds: 60,
};

/**
 * Keyed by IP, not by email -- this is deliberately IN ADDITION TO
 * OTP_RESEND_COOLDOWN_SECONDS (packages/shared/src/constants/auth.ts),
 * which is per-USER and prevents spamming ONE inbox. This bucket instead
 * caps how many DIFFERENT emails one IP can request OTPs for per minute,
 * which the per-user cooldown alone does nothing to stop.
 */
export const RATE_LIMIT_RESEND_OTP: RateLimitBucket = {
  bucket: 'resend-otp',
  limit: 5,
  windowSeconds: 60,
};

/**
 * The widest budget of the four: OTP_MAX_ATTEMPTS (5) already locks out
 * an individual OTP well before this would ever trigger for a legitimate
 * user correcting a typo. This bucket exists as the OUTER guard against an
 * attacker cycling through many different (email, guess) pairs from one
 * IP faster than any single OTP's own attempt cap would catch -- exactly
 * the gap OTP_MAX_ATTEMPTS's own comment calls out.
 */
export const RATE_LIMIT_VERIFY_OTP: RateLimitBucket = {
  bucket: 'verify-otp',
  limit: 20,
  windowSeconds: 60,
};
