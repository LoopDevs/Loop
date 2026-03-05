/** Standard error response body from the Loop backend. */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

/** Error thrown when a backend API call fails. */
export class ApiException extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiException';
    this.code = error.code;
    this.status = status;
    this.details = error.details;
  }
}

/** Standard API error codes. */
export const ApiErrorCode = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

// ─── Auth ────────────────────────────────────────────────────────────────────

/** POST /api/auth/request-otp */
export interface RequestOtpRequest {
  email: string;
}

/** POST /api/auth/verify-otp */
export interface VerifyOtpRequest {
  email: string;
  otp: string;
}

/** Response from POST /api/auth/verify-otp */
export interface VerifyOtpResponse {
  accessToken: string;
  refreshToken: string;
}

/** POST /api/auth/refresh */
export interface RefreshRequest {
  /** Required when the refresh token is not in a cookie (mobile). */
  refreshToken?: string;
}

/** Response from POST /api/auth/refresh */
export interface RefreshResponse {
  accessToken: string;
}

// ─── Image proxy ─────────────────────────────────────────────────────────────

/** Query params for GET /api/image */
export interface ImageProxyParams {
  url: string;
  width?: number;
  height?: number;
  quality?: number;
}
