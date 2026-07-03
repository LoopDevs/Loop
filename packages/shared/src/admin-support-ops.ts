/**
 * Support-dashboard wire shapes (ADR 037 §4) — the watcher-skip
 * browser, the per-user wallet card, the reverse lookup, and the
 * three delivery-unsticking action results. Lives in `@loop/shared`
 * per ADR 019: backend emits them, the admin web views consume
 * them, and the shared-type-parity gate holds both sides to one
 * definition.
 */
import type { WalletProvisioningState } from './users-wallet.js';

// ─── Watcher skip rows (payment_watcher_skips, migration 0033) ─────────────

// `refunding` / `refunded` added by hardening A6 — an abandoned late
// deposit an operator refunded to its sender (or is mid-refund).
export const WATCHER_SKIP_STATUSES = [
  'pending',
  'resolved',
  'abandoned',
  'refunding',
  'refunded',
] as const;
export type WatcherSkipStatus = (typeof WATCHER_SKIP_STATUSES)[number];

export const WATCHER_SKIP_REASONS = [
  'asset_mismatch',
  'amount_insufficient',
  'missing_credit_row',
  'processing_error',
] as const;
export type WatcherSkipReason = (typeof WATCHER_SKIP_REASONS)[number];

/** One skipped-deposit row in `GET /api/admin/watcher-skips`. */
export interface AdminWatcherSkipRow {
  /** Horizon operation id — the row's primary key. */
  paymentId: string;
  memo: string;
  /** Order the memo matched at skip time; null when unmatched. */
  orderId: string | null;
  reason: WatcherSkipReason;
  status: WatcherSkipStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/admin/watcher-skips` (keyset-paginated, newest first). */
export interface AdminWatcherSkipsListResponse {
  rows: AdminWatcherSkipRow[];
}

/**
 * `GET /api/admin/watcher-skips/:paymentId` — the list row plus the
 * jsonb snapshot of the parsed Horizon record the retry sweep
 * replays.
 */
export interface AdminWatcherSkipDetail extends AdminWatcherSkipRow {
  payment: Record<string, unknown>;
}

/** `result` half of POST /api/admin/watcher-skips/:paymentId/reopen. */
export interface AdminWatcherSkipReopenResult {
  paymentId: string;
  priorStatus: 'abandoned';
  status: 'pending';
  /** Reset to 0 so the sweep gets a fresh retry budget. */
  attempts: number;
}

// ─── Per-user wallet card (ADR 030 / ADR 037 user-360) ─────────────────────

/** One on-chain trustline balance on the user's wallet account. */
export interface AdminUserWalletBalance {
  assetCode: string;
  assetIssuer: string;
  /** Stroops as string (bigint-as-string convention). */
  balanceStroops: string;
  /** Trustline limit in stroops as string. */
  limitStroops: string;
}

/** `GET /api/admin/users/:userId/wallet` */
export interface AdminUserWalletResponse {
  userId: string;
  provider: 'privy' | null;
  /** Provider-side wallet identifier (Privy CUID2). */
  walletId: string | null;
  /** Embedded-wallet Stellar address (ADR 030 Phase C). */
  walletAddress: string | null;
  /** Legacy self-linked payout address (ADR 015). */
  stellarAddress: string | null;
  provisioning: WalletProvisioningState;
  provisioningAttempts: number;
  provisioningLastAttemptAt: string | null;
  /**
   * On-chain snapshot via the Horizon trustline reader; null when
   * Horizon was unreachable (the admin card renders a retry hint —
   * unlike /api/me/wallet there is no last-known-good fallback,
   * because support needs the truth, not a stale echo).
   */
  onChain: {
    accountExists: boolean;
    balances: AdminUserWalletBalance[];
    /** ISO-8601 snapshot time (30s-cached reader). */
    asOf: string;
  } | null;
}

/** `result` half of POST /api/admin/users/:userId/wallet/reprovision. */
export interface AdminWalletReprovisionResult {
  userId: string;
  /** Provisioning state at the time of the re-enqueue. */
  priorProvisioning: Exclude<WalletProvisioningState, 'activated'>;
  /** Attempts counter after the reset. */
  attempts: number;
  /** True — the provisioning drive was re-enqueued after commit. */
  requeued: boolean;
}

// ─── Order redemption re-fetch (ADR 037 delivery-unsticking) ────────────────

/** `result` half of POST /api/admin/orders/:orderId/refetch-redemption. */
export interface AdminRefetchRedemptionResult {
  orderId: string;
  /** True when the re-fetch recovered at least one redemption field. */
  recovered: boolean;
  /** Which fields are now present (codes themselves are never echoed). */
  hasCode: boolean;
  hasPin: boolean;
  hasUrl: boolean;
  /** Backfill attempts counter after this fetch. */
  attempts: number;
}

// ─── Reverse lookup (ADR 037 user-360 entry point) ──────────────────────────

export type AdminLookupKind = 'order' | 'payment_memo' | 'stellar_address';

/**
 * `GET /api/admin/lookup?q=<order id | payment memo | stellar address>`
 *
 * Resolves an artifact a customer can quote (order id from the app,
 * the 20-char base32 payment memo from their wallet history, or a
 * Stellar address) to the owning user. Index-backed only.
 */
export interface AdminLookupResponse {
  kind: AdminLookupKind;
  userId: string;
  /** Present for `order` and `payment_memo` lookups. */
  orderId?: string;
}
