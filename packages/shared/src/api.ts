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
  // Hardening B5 — per-email OTP verify lockout (verify-otp).
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  // A5-3 — per-target velocity cap on admin clear-otp-lockout (429).
  OTP_LOCKOUT_CLEAR_RATE_EXCEEDED: 'OTP_LOCKOUT_CLEAR_RATE_EXCEEDED',
  // A5-3 — clear-otp-lockout fail-closed when the per-target count query errors (503).
  OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE: 'OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE',
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
  // The stored replay snapshot for an (admin, Idempotency-Key) pair
  // is unreadable. The original write committed (snapshots persist
  // in the same txn as the write), so the guard refuses to
  // re-execute — 500, ops escalation, never an automatic re-run.
  IDEMPOTENCY_SNAPSHOT_CORRUPT: 'IDEMPOTENCY_SNAPSHOT_CORRUPT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_CREDIT: 'INSUFFICIENT_CREDIT',
  HOME_CURRENCY_LOCKED: 'HOME_CURRENCY_LOCKED',
  IN_FLIGHT_ORDERS: 'IN_FLIGHT_ORDERS',
  PENDING_PAYOUTS: 'PENDING_PAYOUTS',
  // Kept under the legacy name deliberately: only pre-ADR-036
  // withdrawal-era payouts (at-send-debited) can block DSR deletion.
  FAILED_UNCOMPENSATED_WITHDRAWALS: 'FAILED_UNCOMPENSATED_WITHDRAWALS',
  // PLAT-30-03 (2026-06-30 cold audit): DSR self-delete blocks on a
  // non-zero user_credits balance in any currency.
  BALANCE_NOT_ZERO: 'BALANCE_NOT_ZERO',
  REFUND_ALREADY_ISSUED: 'REFUND_ALREADY_ISSUED',
  // Hardening A6 — late-deposit refund-to-sender (admin).
  DEPOSIT_NOT_REFUNDABLE: 'DEPOSIT_NOT_REFUNDABLE',
  REFUND_SUBMIT_FAILED: 'REFUND_SUBMIT_FAILED',
  // CF-06 admin-refund order validation. The bound order must exist
  // (ORDER_NOT_FOUND → 404), belong to the refund target
  // (ORDER_USER_MISMATCH → 409, defends against IDOR / fabricated
  // orders), have been charged in the refund currency
  // (REFUND_CURRENCY_MISMATCH → 409), and the amount must not exceed
  // the order's charge (REFUND_EXCEEDS_CHARGE → 409, defends against
  // over-refund).
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_USER_MISMATCH: 'ORDER_USER_MISMATCH',
  REFUND_CURRENCY_MISMATCH: 'REFUND_CURRENCY_MISMATCH',
  REFUND_EXCEEDS_CHARGE: 'REFUND_EXCEEDS_CHARGE',
  // ADR 036: emission (ex-ADR-024 withdrawal) duplicate-intent fence.
  // Replaces the retired WITHDRAWAL_ALREADY_ISSUED — the withdrawal
  // route + `credits/withdrawals.ts` are gone, superseded entirely by
  // the emission primitive.
  EMISSION_ALREADY_ISSUED: 'EMISSION_ALREADY_ISSUED',
  // Hardening A1 (2026-07 plan): cumulative emission conservation —
  // the requested emission exceeds the un-emitted portion of the
  // user's mirror liability (prior payouts/emissions already
  // materialised it on-chain). 409; the admin UI shows the remaining
  // headroom from the message.
  EMISSION_EXCEEDS_UNEMITTED_BALANCE: 'EMISSION_EXCEEDS_UNEMITTED_BALANCE',
  ALREADY_COMPENSATED: 'ALREADY_COMPENSATED',
  PAYOUT_NOT_COMPENSABLE: 'PAYOUT_NOT_COMPENSABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  // M-3 (deep linking): `GET /.well-known/apple-app-site-association`
  // and `GET /.well-known/assetlinks.json` 404 with this code when
  // their gating env var (APPLE_TEAM_ID / ANDROID_CERT_SHA256) is
  // unset. Distinct from NOT_CONFIGURED (503) rather than reusing it —
  // "the verification file for this domain doesn't exist yet" is the
  // correct 404 semantics for both Apple's and Google's link-
  // verification crawlers, not a retryable server outage.
  WELL_KNOWN_NOT_CONFIGURED: 'WELL_KNOWN_NOT_CONFIGURED',
  // ADR 036 OQ3 (resolved 2026-06-12): the `credit` payment method
  // is retired once the caller's embedded wallet is `activated` and
  // the wallet layer is on — their balance IS their tokens, so
  // spending happens as token redemption (`loop_asset` /
  // POST /api/orders/loop/:id/redeem). Returned by
  // `loopCreateOrderHandler`; not-yet-activated users (mirror balance
  // accrued pre-wallet) keep `credit` working as the migration
  // window. Replaces the blanket A4-110(b) PAYMENT_METHOD_DISABLED
  // gate, which is now scoped precisely to the emitted balance.
  CREDIT_METHOD_RETIRED: 'CREDIT_METHOD_RETIRED',
  // AUDIT-2 finding B (2026-07 hardening): `loop_asset` is a Phase-2
  // spend surface (redemption of on-chain LOOP). Previously only
  // client-side UI + the incidental absence of funded wallets kept a
  // direct API caller from creating/redeeming a loop_asset order at
  // full face value while LOOP_PHASE_1_ONLY=true. Returned by
  // `loopCreateOrderHandler` (paymentMethod='loop_asset') and
  // `redeemLoopOrderHandler` (an already-created loop_asset order)
  // whenever LOOP_PHASE_1_ONLY is true — mirrors the CREDIT_METHOD_RETIRED
  // shape above, structural rather than incidental.
  LOOP_ASSET_UNAVAILABLE_PHASE_1: 'LOOP_ASSET_UNAVAILABLE_PHASE_1',
  // ADR-028 / A4-063 admin step-up auth. Distinct codes so the
  // admin UI can branch: REQUIRED → prompt for password modal;
  // INVALID → re-prompt (token expired or signature failed);
  // SUBJECT_MISMATCH → log out (different admin's token replayed);
  // UNAVAILABLE → ops error (operator hasn't generated the key).
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  STEP_UP_INVALID: 'STEP_UP_INVALID',
  STEP_UP_SUBJECT_MISMATCH: 'STEP_UP_SUBJECT_MISMATCH',
  STEP_UP_UNAVAILABLE: 'STEP_UP_UNAVAILABLE',
  // CF-08: a step-up token minted for one action class was replayed
  // against a different one. The admin UI re-prompts (same flow as
  // STEP_UP_INVALID) but minting for the correct action.
  STEP_UP_PURPOSE_MISMATCH: 'STEP_UP_PURPOSE_MISMATCH',
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
  // CF-19 (ADR 035): an extended-market order (AED/INR/SAR/AUD/MXN) was
  // requested but the external rates service doesn't yet serve a live
  // fiat→crypto rate for that currency. Returned 503 from
  // `POST /api/orders/loop` so the SEO-promoted display markets fail
  // gracefully ("ordering for this market is coming soon") instead of
  // crashing or charging a wrong amount. Goes away once the rates
  // service serves the currency — purely an external dependency, not a
  // user-input problem. Distinct from SERVICE_UNAVAILABLE (a genuine FX
  // feed outage for a currency we DO support).
  CURRENCY_NOT_AVAILABLE: 'CURRENCY_NOT_AVAILABLE',
  // ADR 030 Phase C — POST /api/orders/loop/:id/redeem.
  // ORDER_NOT_PAYABLE: the order isn't a loop_asset order awaiting
  // payment (wrong payment method, or a terminal failed/expired
  // state — already-paid states replay 200 instead).
  ORDER_NOT_PAYABLE: 'ORDER_NOT_PAYABLE',
  // A concurrent redeem call for the same order is still
  // in flight (in-process fence). Retry after the first resolves.
  PAYMENT_IN_FLIGHT: 'PAYMENT_IN_FLIGHT',
  // The caller's embedded wallet isn't provisioned + activated yet,
  // so there is no on-chain balance to pay from.
  WALLET_NOT_ACTIVATED: 'WALLET_NOT_ACTIVATED',
  // ADR 037 — staff role management. SELF_REVOKE: you cannot revoke
  // or demote your own admin role (another admin must); LAST_ADMIN:
  // the write would leave zero effective admins.
  STAFF_SELF_REVOKE: 'STAFF_SELF_REVOKE',
  STAFF_LAST_ADMIN: 'STAFF_LAST_ADMIN',
  // ADR 037 — support delivery-unsticking actions. Each is the
  // "nothing to re-drive" 409 for its surface: the watcher-skip
  // reopen (row not abandoned), the wallet reprovision (already
  // activated), and the redemption re-fetch (order not fulfilled /
  // no ctx_order_id / payload already present).
  SKIP_NOT_ABANDONED: 'SKIP_NOT_ABANDONED',
  WALLET_ALREADY_ACTIVATED: 'WALLET_ALREADY_ACTIVATED',
  REDEMPTION_NOT_REFETCHABLE: 'REDEMPTION_NOT_REFETCHABLE',
  // A5-1 — admin order re-drive lever (paid-only). NOT_REDRIVABLE
  // (400): the order is not `paid` (a terminal / pre-payment state —
  // nothing to redrive). IN_PROGRESS (409): the order is `procuring`
  // — force-re-procuring an in-flight order is a double-pay / stranding
  // risk, so it's refused; stuck procuring orders are auto-recovered by
  // the recovery sweep instead.
  ORDER_NOT_REDRIVABLE: 'ORDER_NOT_REDRIVABLE',
  ORDER_REDRIVE_IN_PROGRESS: 'ORDER_REDRIVE_IN_PROGRESS',
  // A5-4 — order-bound admin refund. NOT_REFUNDABLE (400): the order is
  // `pending_payment` / `expired` — nothing was ever charged, or it
  // already lapsed with nothing to reverse. ATTESTATION_REQUIRED (400):
  // the order is `fulfilled` and the request didn't carry the required
  // code-unused attestation. ALREADY_REFUNDED (409): a refund already
  // exists for this order (INV-8). CTX_ALREADY_PAID (409): the order is
  // `procuring` and Loop has already paid CTX for it — refunding now
  // would double-lose money; escalate instead of refunding blind.
  // UNSUPPORTED_PAYMENT_METHOD (409): `loop_asset` — matches the
  // existing R3-2 fail-closed posture, not a new gap. SUBMIT_FAILED
  // (502): the on-chain refund-to-sender attempt failed or the order
  // predates the payment-snapshot columns (pre-migration order — refund
  // manually).
  ORDER_NOT_REFUNDABLE: 'ORDER_NOT_REFUNDABLE',
  ORDER_REFUND_ATTESTATION_REQUIRED: 'ORDER_REFUND_ATTESTATION_REQUIRED',
  ORDER_ALREADY_REFUNDED: 'ORDER_ALREADY_REFUNDED',
  ORDER_REFUND_CTX_ALREADY_PAID: 'ORDER_REFUND_CTX_ALREADY_PAID',
  ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD: 'ORDER_REFUND_UNSUPPORTED_PAYMENT_METHOD',
  ORDER_REFUND_SUBMIT_FAILED: 'ORDER_REFUND_SUBMIT_FAILED',
  // ADR 045 (B-3): Phase-1 fraud/abuse velocity limit on
  // `POST /api/orders/loop`. EXCEEDED (429): the user already has
  // `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW` orders, or
  // `LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR` of charge value in one
  // currency, within the rolling `LOOP_ORDER_VELOCITY_WINDOW_HOURS`
  // window — a per-USER cap, distinct from the per-IP rate limiter.
  // CHECK_UNAVAILABLE (503): the bounded count/sum query itself
  // failed — fails CLOSED (no order created), mirroring the A5-3
  // OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE shape.
  ORDER_VELOCITY_EXCEEDED: 'ORDER_VELOCITY_EXCEEDED',
  ORDER_VELOCITY_CHECK_UNAVAILABLE: 'ORDER_VELOCITY_CHECK_UNAVAILABLE',
  // ADR 031 V7 — admin vault-emission / vault-redemption re-drive.
  // ALREADY_MIRRORED / ALREADY_SETTLED (409): the row already reached
  // its terminal success state — nothing to redrive. REDRIVE_RACE
  // (409): the row changed state between this call's initial read and
  // its locked reclaim (almost always a concurrent redrive) — re-check
  // the row's current state before retrying. NEEDS_REFUND (409,
  // redemption only): the row's payout already landed but its source
  // order was no longer payable at mirror time — the mirror debit was
  // deliberately never applied and the collected shares need a MANUAL
  // refund; re-driving would just hit the same non-payable order again,
  // so it's refused rather than silently re-attempting a payout.
  VAULT_EMISSION_ALREADY_MIRRORED: 'VAULT_EMISSION_ALREADY_MIRRORED',
  VAULT_EMISSION_REDRIVE_RACE: 'VAULT_EMISSION_REDRIVE_RACE',
  VAULT_REDEMPTION_ALREADY_SETTLED: 'VAULT_REDEMPTION_ALREADY_SETTLED',
  VAULT_REDEMPTION_NEEDS_REFUND: 'VAULT_REDEMPTION_NEEDS_REFUND',
  VAULT_REDEMPTION_REDRIVE_RACE: 'VAULT_REDEMPTION_REDRIVE_RACE',
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

/**
 * Response from POST /api/auth/social/google and
 * POST /api/auth/social/apple (ADR 014). The backend always returns
 * `email` on social paths because the user never typed it; callers
 * that don't need it can ignore the field.
 */
export interface SocialLoginResponse extends VerifyOtpResponse {
  email: string;
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
