/**
 * Support-dashboard wire shapes (ADR 037 §4) — the watcher-skip
 * browser, the per-user wallet card, the reverse lookup, the
 * fleet-wide ledger browser (A5-8), and the three delivery-
 * unsticking action results. Lives in `@loop/shared` per ADR 019:
 * backend emits them, the admin web views consume them, and the
 * shared-type-parity gate holds both sides to one definition.
 */
import type { WalletProvisioningState } from './users-wallet.js';
import type { CreditTransactionType } from './credit-transaction-type.js';

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
  // T0-1: a deposit whose memo maps to a real order that's no longer
  // pending_payment (expired / already paid) — a genuine late or
  // duplicate deposit. Recorded so the A6 refund path can reach it.
  'order_gone',
  // AUDIT-2 finding C: value delivered TO the deposit address that
  // matched NO configured rail at all (wrong/no memo, or an asset/
  // issuer/amount no order or allowlist recognizes) — previously
  // silently dropped with no DB row. Distinct from `order_gone`
  // (there the memo DID resolve to a real order); here nothing
  // resolved, so there's no `orderId` to attach.
  'unrecognized_deposit',
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

// ─── Fleet-wide ledger browser (ADR 037 §4.2 / A5-8) ────────────────────────

/**
 * One row in `GET /api/admin/ledger` — the fleet-wide (all users)
 * paginated browse over `credit_transactions`. Same shape as the
 * per-user `AdminCreditTransactionView`
 * (`admin/user-credit-transactions.ts`) plus `userId`, since this
 * view spans every user rather than being scoped under a
 * `/users/:userId` path.
 */
export interface AdminLedgerEntry {
  id: string;
  userId: string;
  type: CreditTransactionType;
  /** bigint-as-string, signed. Positive for cashback/interest/refund, negative for spend/withdrawal; adjustment can be either. */
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/**
 * `GET /api/admin/ledger` (newest first, keyset-paginated via
 * `?before=<iso>`, bounded `?limit=` [1, 200] default 50). See the
 * handler doc (`admin/ledger.ts`) for how every filter combination
 * stays on an indexed access path.
 */
export interface AdminLedgerListResponse {
  transactions: AdminLedgerEntry[];
}

// ─── Per-subject audit timeline (ADR 037 §4 / A5-7) ─────────────────────────

/**
 * Discriminator for one merged timeline row. Each underlying DB row
 * becomes exactly ONE event (never expanded into per-milestone
 * sub-events) — an order or payout's full state history rides in
 * `detail` instead, so the event count stays predictable regardless
 * of how many timestamps a row has populated.
 */
export const ADMIN_AUDIT_TIMELINE_EVENT_KINDS = [
  'admin_action',
  'ledger',
  'order',
  'payout',
  'session_revoked',
  'auth_lock',
] as const;
export type AdminAuditTimelineEventKind = (typeof ADMIN_AUDIT_TIMELINE_EVENT_KINDS)[number];

/**
 * One row in `GET /api/admin/users/:userId/audit`. `detail` is a
 * flat, kind-specific bag (bigint money fields as strings, per the
 * repo-wide convention) — the UI renders it as a definition list
 * under the event rather than the backend maintaining a per-kind
 * response shape for every consumer.
 */
export interface AdminAuditTimelineEvent {
  kind: AdminAuditTimelineEventKind;
  /** ISO-8601 — the merge/sort key (newest first). */
  at: string;
  /** Short human-readable one-liner for the timeline row. */
  summary: string;
  /** Drill-link target for the web UI, when one exists. */
  refType: 'order' | 'payout' | null;
  refId: string | null;
  detail: Record<string, string | number | boolean | null>;
}

/**
 * One source's compound keyset cursor. A single-column `at`-only
 * cursor is NOT sufficient: a source can write many rows sharing the
 * exact same timestamp (e.g. `revokeAllRefreshTokensForUser` stamps
 * one `revokedAt` on every live session in one UPDATE; interest-mint
 * inserts a transaction-stable `now()` per credit row), and a naive
 * `WHERE ts < cursor` at a page boundary would silently DROP the tied
 * rows that didn't fit on the page. So the cursor is `(at, id)` and
 * the query pages with `ts < at OR (ts = at AND id < id)` ordered by
 * `(ts DESC, id DESC)`. `id` is that source's stable unique row key
 * (uuid / jti / idempotency key).
 */
export interface AdminAuditTimelineCursor {
  /** ISO-8601 timestamp of the oldest row this source returned. */
  at: string;
  /** That row's stable unique id — the keyset tiebreaker. */
  id: string;
}

/**
 * Per-source keyset cursors for `GET /api/admin/users/:userId/audit`.
 *
 * The timeline merges five INDEPENDENTLY paginated sources, so it
 * cannot use one shared `before` value — with uneven per-source
 * density (e.g. many ledger rows per order) a single global cursor
 * = the oldest `at` across the merged page would permanently DROP the
 * denser source's un-returned rows on the next page (they're newer
 * than the global floor, so they never satisfy `< floor`). Instead
 * each source carries its OWN compound `(at, id)` cursor.
 *
 * On a response, each field is the `(at, id)` of the OLDEST row that
 * source returned this page, or `null` when that source is exhausted
 * (returned fewer than `limit` rows, or wasn't queried this page). On
 * the next request the client echoes this object back: each non-null
 * cursor pages ITS source older; a null cursor means "don't re-query
 * that source". When every field is null the walk is done.
 *
 * The single-row OTP-lock snapshot is NOT a paged source — it appears
 * once (page 1 only) and has no cursor here.
 */
export interface AdminAuditTimelineCursors {
  /** admin_idempotency_keys rows targeting this user (createdAt, key). */
  adminActions: AdminAuditTimelineCursor | null;
  /** credit_transactions (createdAt, id). */
  ledger: AdminAuditTimelineCursor | null;
  /** orders (createdAt, id). */
  orders: AdminAuditTimelineCursor | null;
  /** pending_payouts (createdAt, id). */
  payouts: AdminAuditTimelineCursor | null;
  /** refresh_tokens revocations (revokedAt, jti). */
  sessions: AdminAuditTimelineCursor | null;
}

/**
 * Wire codec for a compound audit cursor in a `before<Source>` query
 * param: `<isoTs>|<id>`. An ISO-8601 timestamp never contains `|`, so
 * splitting on the FIRST `|` reconstructs `id` losslessly even if the
 * id itself contains `|` (an opaque idempotency key can). Backend
 * decodes; web encodes — kept together so they can't drift.
 */
export function encodeAuditCursor(cursor: AdminAuditTimelineCursor): string {
  return `${cursor.at}|${cursor.id}`;
}

/** Returns null on a malformed token (no separator, or an empty half). */
export function decodeAuditCursor(raw: string): AdminAuditTimelineCursor | null {
  const i = raw.indexOf('|');
  if (i <= 0 || i === raw.length - 1) return null;
  return { at: raw.slice(0, i), id: raw.slice(i + 1) };
}

/**
 * `GET /api/admin/users/:userId/audit` — merges five bounded,
 * already-indexed per-user reads (admin actions targeting this user,
 * credit_transactions, orders, pending_payouts, refresh_tokens
 * revocations) plus a current-state OTP-lock snapshot into one
 * newest-first timeline PAGE. `?limit=` bounds EACH source
 * independently (default 8, clamped [1, 20]); `nextCursors` carries
 * the per-source keyset cursors for the next page (see
 * `AdminAuditTimelineCursors`). See the handler doc
 * (`admin/user-audit-timeline.ts`) for why the admin-actions source
 * only covers a trailing 24h window and why OTP lock is a snapshot,
 * not a history.
 */
export interface AdminUserAuditTimelineResponse {
  userId: string;
  events: AdminAuditTimelineEvent[];
  /** Per-source cursors to fetch the next (older) page. */
  nextCursors: AdminAuditTimelineCursors;
}
