/**
 * Section 34 error hierarchy.
 *
 * Every error the application deliberately throws (as opposed to an
 * unexpected bug) extends AppError. The centralized error handler
 * (apps/api/src/plugins/error-handler.ts, built in Phase 4) uses
 * `instanceof AppError` to decide: known error -> map to `code`/`httpStatus`
 * and return `error.message` to the client; unknown error -> log full detail,
 * return a generic "internal error" with no stack trace to the client.
 *
 * `code` is a stable machine-readable string (SEAT_NOT_AVAILABLE, not just
 * an HTTP status) because the frontend needs to branch on *why* a request
 * failed, not just that it failed with a 409. HTTP status alone collapses
 * "seat taken" and "reservation already cancelled" into the same 409.
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  /** Safe to show verbatim to the client. Never put internal detail here. */
  public readonly isOperational = true;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  readonly httpStatus = 400;
  readonly code = 'BAD_REQUEST';
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'Authentication required', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'FORBIDDEN';

  constructor(message = 'You do not have permission to perform this action', details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * A separate class from ForbiddenError, both 403, because the CLIENT
 * needs to tell them apart: `FORBIDDEN` means "you're logged in but not
 * allowed to do that" (retrying won't help); `CSRF_VALIDATION_FAILED`
 * means "your CSRF token is missing/stale" (refetching it and retrying
 * the same request will). See apps/api/src/plugins/csrf.ts.
 */
export class CsrfError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'CSRF_VALIDATION_FAILED';

  constructor(message = 'CSRF validation failed. Please refresh and try again.') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = 'NOT_FOUND';

  constructor(resource: string, details?: Record<string, unknown>) {
    super(`${resource} not found`, details);
  }
}

export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = 'CONFLICT';
}

export class RateLimitError extends AppError {
  readonly httpStatus = 429;
  readonly code = 'RATE_LIMIT_EXCEEDED';

  constructor(
    message = 'Too many requests',
    public readonly retryAfterSeconds?: number,
  ) {
    super(message, retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined);
  }
}

export class InternalServerError extends AppError {
  readonly httpStatus = 500;
  readonly code = 'INTERNAL_SERVER_ERROR';

  constructor(message = 'An unexpected error occurred') {
    super(message);
  }
}

/**
 * A genuinely unreachable dependency (Redis, at minimum -- see
 * apps/api/src/plugins/auth-hook.ts), not a bug in this codebase. 503,
 * not 500: the request was well-formed and the SERVER knows exactly
 * what's wrong (a dependency it needs is down), which is precisely what
 * distinguishes "service temporarily unavailable" from "an unexpected
 * error occurred" (Phase 19, found live: before this class existed, a
 * Redis outage during session lookup fell through to a generic 500,
 * indistinguishable from an actual application bug).
 */
export class ServiceUnavailableError extends AppError {
  readonly httpStatus = 503;
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor(message = 'A required service is temporarily unavailable. Please try again shortly.') {
    super(message);
  }
}

/**
 * Domain-specific errors get their own `code` even though they map to a
 * generic HTTP status, because the client needs to distinguish them.
 * Example: SEAT_NOT_AVAILABLE (409) vs RESERVATION_ALREADY_CANCELLED (409)
 * drive different UI ("pick another seat" vs "this booking is closed").
 */
export class DomainConflictError extends AppError {
  readonly httpStatus = 409;

  constructor(
    public readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

/**
 * Same idea as DomainConflictError, but for cases that are wrong INPUT
 * rather than a resource-state conflict -- an incorrect OTP is the
 * motivating example: the request is well-formed, but the value itself
 * is wrong, which is a 400 in REST convention, not a 409 (nothing is
 * "in conflict"; the guess was simply incorrect).
 */
export class DomainBadRequestError extends AppError {
  readonly httpStatus = 400;

  constructor(
    public readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}
