import { baseEnvSchema, loadEnv } from '@flashsale/config';
import { z } from 'zod';

/**
 * docker-compose.yml passes `${VAR:-}` for optional settings, which arrives
 * as an empty string rather than an absent variable -- treat the two the
 * same so an unset optional value never fails validation.
 */
function blankAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

/**
 * Worker-specific env. Notably absent: CORS_ORIGIN, COOKIE_SECRET -- the
 * worker has no REQUEST-serving HTTP surface, just the tiny liveness-only
 * health port Phase 20 added (see health-server.ts).
 */
const workerEnvSchema = baseEnvSchema.extend({
  // Caps how many jobs/stream entries this process handles at once.
  // Kept here (not hardcoded per-queue) so it can be tuned per deployment
  // without a code change -- e.g. lower on a small EC2 instance.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Phase 20: a tiny liveness-only HTTP port (health-server.ts) so
  // container orchestration (Docker's own HEALTHCHECK, and eventually
  // Phase 21's AWS target group health checks) has something to poll --
  // previously "is the worker alive" had no answer beyond "the container
  // hasn't exited," which `docker ps` already shows regardless.
  //
  // `WORKER_PORT`, NOT `PORT` -- found live while getting Phase 22's
  // frontend running via `pnpm dev`: apps/api and apps/worker share ONE
  // root `.env` file for host-run dev, and `.env`'s single `PORT=4000`
  // (meant for api) was ALSO being read by this schema's old `PORT`
  // field, silently overriding this default of 4100 and making the
  // worker's health server fight api for the exact same port. Naming
  // this schema's field the same as api's (`PORT`) was only ever safe
  // under Docker, where docker-compose.yml sets a genuinely separate
  // `PORT` value per service -- one shared `.env` file has no such
  // isolation, so the two processes' ports need distinct variable NAMES,
  // not just distinct intended values.
  WORKER_PORT: z.coerce.number().int().positive().default(4100),

  // Which EmailProvider the email worker sends through (see index.ts):
  //  - console: logs instead of sending (local development only)
  //  - smtp:    any SMTP relay (SendGrid, Mailgun, Postmark, SES SMTP,
  //             Mailpit for local testing, ...)
  //  - acs:     Azure Communication Services Email -- what the Azure
  //             deployment (infra/azure) provisions and wires up.
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'acs']).default('console'),
  // Sender address; must be a verified sender for smtp/acs (for ACS, the
  // DoNotReply@<domain> address of the linked email domain).
  EMAIL_FROM: blankAsUndefined(z.string().email()),
  SMTP_HOST: blankAsUndefined(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // true = implicit TLS (port 465); false = STARTTLS upgrade (587).
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: blankAsUndefined(z.string()),
  SMTP_PASSWORD: blankAsUndefined(z.string()),
  ACS_EMAIL_CONNECTION_STRING: blankAsUndefined(z.string()),
}).superRefine((env, ctx) => {
  const require = (key: keyof typeof env, reason: string): void => {
    if (env[key] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required ${reason}` });
    }
  };
  if (env.EMAIL_PROVIDER !== 'console') {
    require('EMAIL_FROM', `when EMAIL_PROVIDER=${env.EMAIL_PROVIDER}`);
  }
  if (env.EMAIL_PROVIDER === 'smtp') {
    require('SMTP_HOST', 'when EMAIL_PROVIDER=smtp');
  }
  if (env.EMAIL_PROVIDER === 'acs') {
    require('ACS_EMAIL_CONNECTION_STRING', 'when EMAIL_PROVIDER=acs');
  }
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const env: WorkerEnv = loadEnv(workerEnvSchema);
