import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

/**
 * Why Pino over winston/console:
 *
 * - Pino serializes to JSON on a worker-free hot path (~5x faster than
 *   winston in benchmarks) which matters here because logging happens on
 *   every request AND every job AND every stream event -- in a project
 *   explicitly about load testing, logger overhead is not free to ignore.
 * - Structured JSON by default -- required for section 35/36 (every log
 *   line must carry requestId/route/etc as queryable fields, not be a
 *   formatted string you'd need to regex apart later).
 * - `redact` is a first-class option, not something bolted on -- critical
 *   given section 35's explicit "never log password/OTP/session secrets/
 *   payment secrets/authorization headers" requirement.
 */

export interface CreateLoggerOptions {
  /** Which process is logging -- becomes the `service` field on every line. */
  service: 'api' | 'worker' | 'web';
  /**
   * Non-optional by design: callers pass `env.LOG_LEVEL`, which the Zod
   * schema in @flashsale/config already defaults to 'info' -- there is
   * never a legitimate "no level" case, so the type shouldn't allow one.
   */
  level: NonNullable<LoggerOptions['level']>;
  /** Pretty-print for local dev; NEVER enable in production (loses structure + is slower). */
  pretty?: boolean;
}

const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'sessionId',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.otp',
  '*.cardNumber',
  '*.cvv',
  '*.secret',
  '*.apiKey',
];

export function createLogger(options: CreateLoggerOptions): PinoLogger {
  const { service, level, pretty = false } = options;

  // Built with a spread rather than a literal `transport: pretty ? {...} :
  // undefined` because `exactOptionalPropertyTypes` (tsconfig.base.json)
  // treats "property present with value undefined" as a distinct, invalid
  // type from "property absent" -- Pino's LoggerOptions doesn't accept the
  // former. Conditionally spreading the key in omits it entirely when unset.
  const baseOptions: LoggerOptions = {
    level,
    base: { service },
    // ISO timestamps are slightly slower than epoch millis but are what
    // every log aggregator (CloudWatch, Loki, Datadog) expects out of the box.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };

  return pino(
    pretty
      ? {
          ...baseOptions,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : baseOptions,
  );
}

export type Logger = PinoLogger;
