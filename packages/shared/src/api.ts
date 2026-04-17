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

/**
 * Platform identifier used for all auth endpoints. The backend maps platform
 * to the upstream CTX client ID (`CTX_CLIENT_ID_WEB|IOS|ANDROID`).
 */
export type Platform = 'web' | 'ios' | 'android';

/**
 * Standard API error codes. Kept in sync with every `{ code: '...' }` returned
 * by the backend so the frontend can `switch` on `ApiErrorCodeValue` instead
 * of comparing to untyped string literals.
 */
export const ApiErrorCode = {
  // Client-side (never sent by backend)
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  // Request validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  // Server / upstream
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_REDIRECT: 'UPSTREAM_REDIRECT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Image proxy specific
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  NOT_AN_IMAGE: 'NOT_AN_IMAGE',
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

// ─── Auth ────────────────────────────────────────────────────────────────────

/** POST /api/auth/request-otp */
export interface RequestOtpRequest {
  email: string;
  /** Backend defaults to 'web' if omitted. */
  platform?: Platform;
}

/** POST /api/auth/verify-otp */
export interface VerifyOtpRequest {
  email: string;
  otp: string;
  /** Backend defaults to 'web' if omitted. */
  platform?: Platform;
}

/** Response from POST /api/auth/verify-otp */
export interface VerifyOtpResponse {
  accessToken: string;
  refreshToken: string;
}

/** POST /api/auth/refresh */
export interface RefreshRequest {
  /** Required — the backend's zod schema rejects empty refresh tokens. */
  refreshToken: string;
  /** Backend defaults to 'web' if omitted. */
  platform?: Platform;
}

/** Response from POST /api/auth/refresh */
export interface RefreshResponse {
  accessToken: string;
  /** Upstream may rotate the refresh token; when present, clients must replace the stored one. */
  refreshToken?: string;
}

// ─── Image proxy ─────────────────────────────────────────────────────────────

/** Query params for GET /api/image */
export interface ImageProxyParams {
  url: string;
  width?: number;
  height?: number;
  quality?: number;
}
