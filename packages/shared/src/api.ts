/** Standard error response body from the Loop backend. */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
  /**
   * Correlation id echoed by the backend's catch-all 500 handler (and
   * mirrored into the `X-Request-Id` response header on every response).
   * Present only when the backend attaches it to the body — most handlers
   * don't. Useful for quoting in bug reports without hunting through
   * devtools for the header.
   */
  requestId?: string | undefined;
}

/** Error thrown when a backend API call fails. */
export class ApiException extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;
  public readonly requestId: string | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiException';
    this.code = error.code;
    this.status = status;
    this.details = error.details;
    this.requestId = error.requestId;
  }
}

/**
 * Platform identifier used for all auth endpoints. The backend maps platform
 * to the upstream CTX client ID (`CTX_CLIENT_ID_WEB|IOS|ANDROID`).
 */
export type Platform = 'web' | 'ios' | 'android';

/**
 * Default CTX client IDs per platform. Single source of truth shared by
 * `apps/web` (sends `X-Client-Id` on authenticated requests) and
 * `apps/backend` (env defaults for `CTX_CLIENT_ID_*` + allowlist in
 * `requireAuth`). Hardcoding the mapping on both sides would let them
 * drift — web would keep sending `loopweb` if backend rolled over to a
 * new client ID for a migration — so both sides import from here.
 *
 * Backend can still override via env vars, but the backend's boot-time
 * warning (see `parseEnv` in apps/backend/src/env.ts) flags when the
 * effective value diverges from this default so operators know to
 * update the web bundle too.
 */
export const DEFAULT_CLIENT_IDS: Record<Platform, string> = {
  web: 'loopweb',
  ios: 'loopios',
  android: 'loopandroid',
};

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
  RATE_LIMITED: 'RATE_LIMITED',
  DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
  // Server / upstream
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_REDIRECT: 'UPSTREAM_REDIRECT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  SUBSYSTEM_DISABLED: 'SUBSYSTEM_DISABLED',
  // Image proxy specific
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  NOT_AN_IMAGE: 'NOT_AN_IMAGE',
  // Request-body limit (A2-1005) — 413 Payload Too Large at the
  // `bodyLimit` middleware boundary, before any handler runs.
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // Admin write contract (ADR 017) — A2-204: every backend-emitted
  // `code` string needs a shared-enum entry so the web switch-ladder
  // catches drift at the TypeScript layer. Ops-facing UX for these
  // is tracked under A2-1153.
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_CREDIT: 'INSUFFICIENT_CREDIT',
  HOME_CURRENCY_LOCKED: 'HOME_CURRENCY_LOCKED',
  IN_FLIGHT_ORDERS: 'IN_FLIGHT_ORDERS',
  PENDING_PAYOUTS: 'PENDING_PAYOUTS',
  REFUND_ALREADY_ISSUED: 'REFUND_ALREADY_ISSUED',
  WITHDRAWAL_ALREADY_ISSUED: 'WITHDRAWAL_ALREADY_ISSUED',
  ALREADY_COMPENSATED: 'ALREADY_COMPENSATED',
  PAYOUT_NOT_COMPENSABLE: 'PAYOUT_NOT_COMPENSABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  // A4-110(b): credit-method spend gate. Returned by
  // `loopCreateOrderHandler` when `paymentMethod='credit'` is
  // requested but the cashback/refund credit-source bucketing
  // hasn't shipped yet. Guard is removed once `user_credits`
  // gains a source-tag column so the credit method can drain
  // only the non-cashback portion safely.
  PAYMENT_METHOD_DISABLED: 'PAYMENT_METHOD_DISABLED',
  // ADR-028 / A4-063 admin step-up auth. Distinct codes so the
  // admin UI can branch: REQUIRED → prompt for password modal;
  // INVALID → re-prompt (token expired or signature failed);
  // SUBJECT_MISMATCH → log out (different admin's token replayed);
  // UNAVAILABLE → ops error (operator hasn't generated the key).
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  STEP_UP_INVALID: 'STEP_UP_INVALID',
  STEP_UP_SUBJECT_MISMATCH: 'STEP_UP_SUBJECT_MISMATCH',
  STEP_UP_UNAVAILABLE: 'STEP_UP_UNAVAILABLE',
  // Admin home-currency change (ADR 015 deferred § support-mediated
  // change). USER_NOT_FOUND is shared with other lookups but the
  // home-currency-set handler is the first to surface it from an
  // admin write surface; the four below are unique to that handler.
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  HOME_CURRENCY_UNCHANGED: 'HOME_CURRENCY_UNCHANGED',
  HOME_CURRENCY_HAS_LIVE_BALANCE: 'HOME_CURRENCY_HAS_LIVE_BALANCE',
  HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS: 'HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS',
  CONCURRENT_CHANGE: 'CONCURRENT_CHANGE',
  // User favourites (per-user merchant pin list).
  MERCHANT_NOT_FOUND: 'MERCHANT_NOT_FOUND',
  FAVORITES_LIMIT_EXCEEDED: 'FAVORITES_LIMIT_EXCEEDED',
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

// A2-802: `RefreshResponse` was exported from `@loop/shared` with zero
// callers — both the backend openapi schema and the web refresh
// fetcher type the response in-place. Removed; the openapi `RefreshResponse`
// at `apps/backend/src/openapi.ts:104` is the canonical wire shape and
// the web client narrows against the same.

// ─── Image proxy ─────────────────────────────────────────────────────────────

/** Query params for GET /api/image */
export interface ImageProxyParams {
  url: string;
  width?: number;
  height?: number;
  quality?: number;
  mode?: 'public' | 'private';
}
