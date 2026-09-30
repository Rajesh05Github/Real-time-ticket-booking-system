import { z } from 'zod';

/**
 * Fields every FLASHSALE process needs, regardless of whether it's the API,
 * the worker, or (eventually) a standalone script.
 *
 * Design note: this is intentionally SMALL. A common failure mode in
 * "shared env config" packages is that every process ends up requiring every
 * env var any process anywhere needs, so a missing SMTP key blocks the
 * worker from booting even though the worker doesn't send email directly.
 * Each app extends this with only the vars *it* actually reads.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Postgres - required everywhere. This is the source of truth; nothing
  // in this system can run without it.
  DATABASE_URL: z.string().url().startsWith('postgresql://'),

  // Redis - required everywhere. Cache/session/lock/rate-limit/streams/pubsub
  // all share one connection config (see packages/redis for the client).
  // `rediss://` (TLS) is required by managed Redis services such as Azure
  // Cache for Redis, which only expose a TLS port; ioredis enables TLS
  // automatically for that scheme.
  REDIS_URL: z
    .string()
    .url()
    .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://'),

  // Structured logging verbosity (see packages/logger).
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Fail-fast env loader.
 *
 * Why fail fast instead of defaulting missing values: a process that boots
 * with an undefined DATABASE_URL doesn't crash immediately -- it crashes on
 * the first request, in production, with a confusing Prisma error instead
 * of a clear "you forgot to set X" message at startup. Validating once at
 * boot turns every misconfiguration into a same-second, readable failure.
 */
export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Deliberately NOT using the structured logger here: the logger itself
    // may depend on env (e.g. LOG_LEVEL), and if env is broken we cannot
    // trust it's initialized. Plain stderr + hard exit is the correct
    // failure mode for "the process cannot possibly do useful work".
    console.error(`\n[env] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  // The cast (not just an annotation) is required, not stylistic: zod's
  // conditional-type inference for `z.infer<TSchema>` collapses to `any`
  // when TSchema is an unresolved generic parameter rather than a concrete
  // schema type, which trips `no-unsafe-return` even though `result.data`
  // is correctly typed at every call site. The generic constraint above
  // (`TSchema extends z.ZodTypeAny`) is what keeps this honest.
  return result.data as z.infer<TSchema>;
}
