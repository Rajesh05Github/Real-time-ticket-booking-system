/**
 * Mirrors every AppError subclass's `code` (packages/shared/src/errors/
 * app-error.ts) plus the dynamic domain codes observed across the API
 * (SEAT_NOT_AVAILABLE, EVENT_HAS_NO_SEATS, etc.) and a few auth.service.ts
 * codes not exported as constants (OTP_COOLDOWN_ACTIVE and friends) --
 * this list is NOT guaranteed exhaustive, which is exactly why every
 * lookup below falls back to `error.message` rather than assuming a code
 * is always present in the map. The API guarantees that fallback is safe
 * to show verbatim (AppError's own "operational" contract).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    if (requestId !== undefined) this.requestId = requestId;
  }

  get retryAfterSeconds(): number | undefined {
    const value = this.details?.retryAfterSeconds;
    return typeof value === 'number' ? value : undefined;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Friendly copy per error code. Never used directly for display without
 * a fallback to `error.message` -- see the module comment above. */
export const ERROR_COPY: Record<string, string> = {
  SEAT_NOT_AVAILABLE: 'Someone just took one of those seats. Pick another.',
  RESERVATION_EXPIRED: 'Your hold expired. Please select seats again.',
  ORDER_ALREADY_EXISTS: 'You already started checkout for this hold.',
  PAYMENT_RETRY_NOT_ALLOWED: "This payment can't be retried right now.",
  REQUEST_IN_PROGRESS: 'Still working on your last request...',
  IDEMPOTENCY_KEY_REUSED: 'That request looks like a duplicate with different details.',
  EVENT_HAS_NO_SEATS: 'Generate seats for this event before publishing it.',
  INVALID_STATUS_TRANSITION: "This event's status just changed. Refreshing.",
  DUPLICATE_SEAT_IDS: 'The same seat was selected twice.',
  RATE_LIMIT_EXCEEDED: 'Too many attempts. Please slow down.',
  CSRF_VALIDATION_FAILED: 'Your session needs refreshing. Please try again.',
  UNAUTHORIZED: 'Please log in to continue.',
  FORBIDDEN: "You don't have access to that.",
  NOT_FOUND: "That couldn't be found.",
  VALIDATION_ERROR: 'Please check the highlighted fields.',
  BAD_REQUEST: 'That request was not valid.',
  SERVICE_UNAVAILABLE: "We're having trouble reaching a service. Try again shortly.",
  INTERNAL_SERVER_ERROR: 'Something went wrong on our end.',
  NETWORK_ERROR: 'Could not reach the server. Check your connection.',
  // auth.service.ts codes not exported as shared constants:
  OTP_COOLDOWN_ACTIVE: 'Please wait before requesting another code.',
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  OTP_INVALID: "That code doesn't match. Check and try again.",
  OTP_MAX_ATTEMPTS_EXCEEDED: 'Too many wrong attempts. Request a new code.',
  EMAIL_ALREADY_VERIFIED: 'This email is already verified -- try logging in.',
};

export function errorCopyFor(err: ApiError): string {
  return ERROR_COPY[err.code] ?? err.message;
}
