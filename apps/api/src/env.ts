import { baseEnvSchema, loadEnv } from '@flashsale/config';
import { z } from 'zod';

/**
 * API-specific env, layered on the shared base (DATABASE_URL, REDIS_URL,
 * LOG_LEVEL, NODE_ENV). Only vars the API process itself reads live here --
 * the worker has its own equivalent file with its own subset (see
 * apps/worker/src/env.ts) even though both ultimately talk to the same
 * Postgres/Redis.
 */
const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  // Comma-separated list of allowed origins for the Next.js app.
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // Session cookie name + secret used to sign/verify the session cookie.
  // The session VALUE lives in Redis (session:{sessionId}); this secret
  // only protects the cookie's integrity, not its content.
  COOKIE_SECRET: z
    .string()
    .min(32, 'COOKIE_SECRET must be at least 32 characters (used to sign cookies)'),

  // How long the process waits for in-flight requests to finish before
  // forcing an exit on SIGTERM/SIGINT. See src/shutdown.ts.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Shared secret the payment provider's webhook call must present
  // (Phase 13) -- a LOCAL DEVELOPMENT SIMPLIFICATION for a real provider's
  // cryptographic request signature (e.g. Stripe's HMAC-signed
  // Stripe-Signature header verified against the raw body). A static
  // shared secret is enough to demonstrate "the webhook route must verify
  // its caller, it is NOT behind requireAuth" without building a full
  // signature-verification scheme for a provider this project doesn't
  // actually integrate with. See docs/payment-flow.md.
  PAYMENT_WEBHOOK_SECRET: z
    .string()
    .min(16, 'PAYMENT_WEBHOOK_SECRET must be at least 16 characters'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const env: ApiEnv = loadEnv(apiEnvSchema);
