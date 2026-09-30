/**
 * Section 33's consistent error shape, generalized to a full response
 * envelope so success and failure look uniform on the wire.
 *
 * Every API response is one of these two shapes -- never a bare array,
 * never a bare object with ad-hoc fields. This is what lets the web app
 * write one generic `apiFetch<T>()` helper instead of per-endpoint parsing.
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  /** Present on paginated list endpoints. */
  meta?: {
    page?: number;
    pageSize?: number;
    total?: number;
    [key: string]: unknown;
  };
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** Echoes X-Request-ID so a user-reported error can be grepped in logs. */
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(data: T, meta?: ApiSuccess<T>['meta']): ApiSuccess<T> {
  return meta !== undefined ? { success: true, data, meta } : { success: true, data };
}

export function apiFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
): ApiFailure {
  return {
    success: false,
    error: details !== undefined ? { code, message, details } : { code, message },
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
