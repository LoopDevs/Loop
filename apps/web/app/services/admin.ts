import { authenticatedRequest } from './api-client';

export interface MerchantCashbackConfig {
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface MerchantCashbackConfigHistoryEntry {
  id: string;
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

/** GET /api/admin/merchant-cashback-configs */
export async function listCashbackConfigs(): Promise<{ configs: MerchantCashbackConfig[] }> {
  return authenticatedRequest<{ configs: MerchantCashbackConfig[] }>(
    '/api/admin/merchant-cashback-configs',
  );
}

/** PUT /api/admin/merchant-cashback-configs/:merchantId */
export async function upsertCashbackConfig(
  merchantId: string,
  body: {
    wholesalePct: number;
    userCashbackPct: number;
    loopMarginPct: number;
    active?: boolean;
  },
): Promise<{ config: MerchantCashbackConfig }> {
  return authenticatedRequest<{ config: MerchantCashbackConfig }>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}`,
    { method: 'PUT', body },
  );
}

/** GET /api/admin/merchant-cashback-configs/:merchantId/history */
export async function cashbackConfigHistory(
  merchantId: string,
): Promise<{ history: MerchantCashbackConfigHistoryEntry[] }> {
  return authenticatedRequest<{ history: MerchantCashbackConfigHistoryEntry[] }>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}/history`,
  );
}

export type LoopAssetCode = 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
export type PayoutState = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface LoopLiability {
  outstandingMinor: string;
  issuer: string | null;
}

export interface TreasuryHolding {
  stroops: string | null;
}

export interface TreasurySnapshot {
  /** Outstanding credit (what Loop owes users), keyed by currency. Minor units, string. */
  outstanding: Record<string, string>;
  /** Ledger-by-type totals, keyed [currency][type]. Minor units, string. */
  totals: Record<string, Record<string, string>>;
  /** ADR 015 — per LOOP asset, outstanding + configured issuer. */
  liabilities: Record<LoopAssetCode, LoopLiability>;
  /** ADR 015 — Loop's yield-earning pile (USDC + XLM operator holdings). */
  assets: {
    USDC: TreasuryHolding;
    XLM: TreasuryHolding;
  };
  /** ADR 015 — outbound Stellar cashback payouts at each state. */
  payouts: Record<PayoutState, string>;
  /** CTX operator pool snapshot — ADR 013. */
  operatorPool: {
    size: number;
    operators: Array<{ id: string; state: string }>;
  };
}

/** GET /api/admin/treasury */
export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  return authenticatedRequest<TreasurySnapshot>('/api/admin/treasury');
}

/**
 * Downloads an admin CSV endpoint by fetching with the bearer token
 * in binary mode, then synthesising a click on a temporary anchor
 * with a Blob URL. Works around the fact that a plain `<a href>`
 * can't attach the Authorization header that admin CSV endpoints
 * require.
 */
export async function downloadAdminCsv(path: string, filename: string): Promise<void> {
  const buf = await authenticatedRequest<ArrayBuffer>(path, { binary: true });
  const blob = new Blob([buf], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Release the blob URL — Firefox leaks memory without this, and
    // Chromium's GC is slow enough that rapid downloads stack up.
    URL.revokeObjectURL(url);
  }
}

/**
 * Per-currency supplier-spend aggregate (ADR 013 / 015). One row per
 * charge currency in the window; `wholesaleMinor` is what Loop owes
 * CTX, `userCashbackMinor` + `loopMarginMinor` are the counts on the
 * other side of the split that fell out of those orders.
 */
export interface SupplierSpendRow {
  currency: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

export interface SupplierSpendResponse {
  since: string;
  rows: SupplierSpendRow[];
}

/**
 * `GET /api/admin/supplier-spend` — per-currency aggregate of what
 * Loop has spent with CTX in the window. Default window 24h;
 * caller passes `?since=<iso>` to override (server clamps to 366d).
 */
export async function getSupplierSpend(
  opts: { since?: string } = {},
): Promise<SupplierSpendResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<SupplierSpendResponse>(
    `/api/admin/supplier-spend${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-operator order-count / success-count / failure-count breakdown
 * (ADR 013). Complements `SupplierSpendRow` — spend is "what did we
 * pay CTX this window", operator-stats is "which CTX operator actually
 * carried it". `lastOrderAt` is the newest `createdAt` attributed to
 * this operator in the window.
 */
export interface OperatorStatsRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  lastOrderAt: string;
}

export interface OperatorStatsResponse {
  since: string;
  rows: OperatorStatsRow[];
}

/**
 * `GET /api/admin/operator-stats` — per-operator aggregate keyed on
 * `orders.ctxOperatorId`. Rows where the operator is still null (pre-
 * procurement) are skipped server-side. Default window 24h; server
 * clamps `?since=` to 366d.
 */
export async function getOperatorStats(
  opts: { since?: string } = {},
): Promise<OperatorStatsResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorStatsResponse>(
    `/api/admin/operator-stats${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * One row from the admin audit tail (ADR 017 / 018). Mirrors the
 * Discord audit message: who did what, when, status. Response body
 * is intentionally omitted — audit is "activity happened" not
 * "here's the prior payload".
 */
export interface AdminAuditTailRow {
  actorUserId: string;
  actorEmail: string;
  method: string;
  path: string;
  status: number;
  createdAt: string;
}

export interface AdminAuditTailResponse {
  rows: AdminAuditTailRow[];
}

/**
 * `GET /api/admin/audit-tail` — newest-first tail of
 * `admin_idempotency_keys`. Admin landing surfaces this as a
 * "recent admin activity" card; the standalone `/admin/audit` page
 * passes `before` to page older rows past the endpoint's 100-row
 * cap.
 */
export async function getAdminAuditTail(
  opts: { limit?: number; before?: string } | number = {},
): Promise<AdminAuditTailResponse> {
  // Back-compat: callers passing a raw number (the original signature,
  // still used by AdminAuditTail on the landing page) keep working.
  const resolved = typeof opts === 'number' ? { limit: opts } : opts;
  const params = new URLSearchParams();
  if (resolved.limit !== undefined) params.set('limit', String(resolved.limit));
  if (resolved.before !== undefined) params.set('before', resolved.before);
  const qs = params.toString();
  return authenticatedRequest<AdminAuditTailResponse>(
    `/api/admin/audit-tail${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-merchant aggregate stats (ADR 011 / 015). Each row sums fulfilled
 * orders for a single merchant in the window; `currency` is the
 * dominant catalog currency for that merchant's volume.
 */
export interface MerchantStatsRow {
  merchantId: string;
  orderCount: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  lastFulfilledAt: string;
  currency: string;
}

export interface MerchantStatsResponse {
  since: string;
  rows: MerchantStatsRow[];
}

/**
 * `GET /api/admin/merchant-stats` — per-merchant stats ranked by
 * Loop-margin-minor descending. Default window 31d; clamped [1, 366].
 */
export async function getMerchantStats(
  opts: { since?: string } = {},
): Promise<MerchantStatsResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<MerchantStatsResponse>(
    `/api/admin/merchant-stats${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Single stuck-order row from `/api/admin/stuck-orders` (ADR 011/013). */
export interface StuckOrderRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  /** ISO timestamp keyed by paid_at or procured_at depending on state. */
  stuckSince: string;
  /** Elapsed minutes since stuckSince. */
  ageMinutes: number;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
}

export interface StuckOrdersResponse {
  thresholdMinutes: number;
  rows: StuckOrderRow[];
}

/**
 * `GET /api/admin/stuck-orders` — orders sitting past the SLO in
 * `paid` or `procuring` states. Admin dashboard polls this to flag
 * potential supplier incidents before users notice.
 */
export async function getStuckOrders(): Promise<StuckOrdersResponse> {
  return authenticatedRequest<StuckOrdersResponse>('/api/admin/stuck-orders');
}

/** Single stuck-payout row from `/api/admin/stuck-payouts` (ADR 015/016). */
export interface StuckPayoutRow {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  /** Bigint-as-string stroops (7 decimals). */
  amountStroops: string;
  state: string;
  /** ISO timestamp keyed by submitted_at (submitted) or created_at (pending). */
  stuckSince: string;
  ageMinutes: number;
  attempts: number;
}

export interface StuckPayoutsResponse {
  thresholdMinutes: number;
  rows: StuckPayoutRow[];
}

/**
 * `GET /api/admin/stuck-payouts` — pending_payouts rows in
 * pending/submitted past the SLO. Complements `getStuckOrders`:
 * orders stuck in CTX procurement, payouts stuck in Stellar
 * submission. Same dashboard poll cadence.
 */
export async function getStuckPayouts(): Promise<StuckPayoutsResponse> {
  return authenticatedRequest<StuckPayoutsResponse>('/api/admin/stuck-payouts');
}

/**
 * One day of order activity — counts of rows created vs fulfilled
 * bucketed to the UTC day. Returned oldest-first so a bar chart
 * renders left-to-right.
 */
export interface OrdersActivityDay {
  day: string;
  created: number;
  fulfilled: number;
}

export interface OrdersActivityResponse {
  days: OrdersActivityDay[];
  windowDays: number;
}

/**
 * `GET /api/admin/orders/activity?days=N` — per-day created/fulfilled
 * orders series for the admin dashboard sparkline. Server clamps
 * N to [1, 90]; default 7.
 */
export async function getOrdersActivity(days?: number): Promise<OrdersActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<OrdersActivityResponse>(`/api/admin/orders/activity${qs}`);
}

/**
 * Top earners ranking (ADR 009 / 015). Grouped by `(user, currency)` —
 * summing across currencies is meaningless. `amountMinor` is the
 * positive cashback sum in the window as a bigint-as-string.
 */
export interface TopUserRow {
  userId: string;
  email: string;
  currency: string;
  count: number;
  amountMinor: string;
}

export interface TopUsersResponse {
  since: string;
  rows: TopUserRow[];
}

/**
 * `GET /api/admin/top-users` — ranked list of users by cashback
 * earned in the window. Default window 30d; clamped [1, 366].
 * Default limit 20; clamped [1, 100].
 */
export async function getTopUsers(
  opts: { since?: string; limit?: number } = {},
): Promise<TopUsersResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<TopUsersResponse>(
    `/api/admin/top-users${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-state counts + stroop sums for a single `asset_code` bucket in
 * `pending_payouts`. Zero-counts are surfaced so the admin UI can
 * show an explicit "0 failed" rather than a missing row.
 */
export interface PerStateBreakdown {
  count: number;
  stroops: string;
}

export interface PayoutsByAssetRow {
  assetCode: string;
  pending: PerStateBreakdown;
  submitted: PerStateBreakdown;
  confirmed: PerStateBreakdown;
  failed: PerStateBreakdown;
}

/**
 * `GET /api/admin/payouts-by-asset` (ADR 015 / 016) — crossed
 * incident-triage view of `pending_payouts` keyed by
 * `(asset_code, state)`. Answers "which LOOP assets are affected
 * when I see N failed payouts?" at a glance.
 */
/** Per-currency minor-unit amount on a single day. */
export interface PerCurrencyAmount {
  currency: string;
  amountMinor: string;
}

/**
 * One day of cashback accrual — count of `cashback`-type transactions
 * plus per-currency minor sums. `byCurrency` is empty on zero-activity
 * days so the UI can render a gap without an extra branch on count.
 */
export interface CashbackActivityDay {
  day: string;
  count: number;
  byCurrency: PerCurrencyAmount[];
}

export interface CashbackActivityResponse {
  days: number;
  rows: CashbackActivityDay[];
}

/**
 * `GET /api/admin/cashback-activity` — oldest-first N-day series of
 * cashback-type `credit_transactions` accrual. Default 30 days; caller
 * passes `?days=<N>` to override (server clamps [1, 180]).
 */
export async function getCashbackActivity(days?: number): Promise<CashbackActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<CashbackActivityResponse>(`/api/admin/cashback-activity${qs}`);
}

export async function getPayoutsByAsset(): Promise<{ rows: PayoutsByAssetRow[] }> {
  return authenticatedRequest<{ rows: PayoutsByAssetRow[] }>('/api/admin/payouts-by-asset');
}

export interface AdminPayoutView {
  id: string;
  userId: string;
  orderId: string;
  assetCode: string;
  assetIssuer: string;
  toAddress: string;
  amountStroops: string;
  memoText: string;
  state: PayoutState;
  txHash: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

/**
 * `GET /api/admin/payouts` — paginated drilldown for the backlog
 * list page. Server validates `state` against the enum, clamps
 * `limit` to 1..100.
 */
export async function listPayouts(opts: {
  state?: PayoutState;
  userId?: string;
  assetCode?: LoopAssetCode;
  limit?: number;
  before?: string;
}): Promise<{ payouts: AdminPayoutView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.assetCode !== undefined) params.set('assetCode', opts.assetCode);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ payouts: AdminPayoutView[] }>(
    `/api/admin/payouts${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * `GET /api/admin/payouts/:id` — single payout drill-down (ADR 015/016).
 * Permalink for an ops ticket; returns the same `AdminPayoutView`
 * shape as a single row from the list endpoint.
 */
export async function getAdminPayout(id: string): Promise<AdminPayoutView> {
  return authenticatedRequest<AdminPayoutView>(`/api/admin/payouts/${encodeURIComponent(id)}`);
}

/**
 * `GET /api/admin/orders/:orderId/payout` — payout associated with an
 * order. 404 when no payout row exists (cashback hasn't emitted yet,
 * or the payout builder skipped this order). The order detail page
 * uses this to surface "where did the on-chain cashback land?"
 * without making ops search the payouts list.
 */
export async function getAdminPayoutByOrder(orderId: string): Promise<AdminPayoutView> {
  return authenticatedRequest<AdminPayoutView>(
    `/api/admin/orders/${encodeURIComponent(orderId)}/payout`,
  );
}

/**
 * ADR 017 admin-write response envelope. Every admin mutation returns
 * `{ result, audit }`; `audit.replayed: true` means the backend found a
 * prior snapshot for the `Idempotency-Key` and returned the stored
 * response verbatim.
 */
export interface AdminWriteAudit {
  actorUserId: string;
  actorEmail: string;
  idempotencyKey: string;
  appliedAt: string;
  replayed: boolean;
}

export interface AdminWriteEnvelope<T> {
  result: T;
  audit: AdminWriteAudit;
}

/**
 * `POST /api/admin/payouts/:id/retry` — flips a failed row back to
 * pending. ADR 017 compliant: caller must supply a reason, and the
 * service generates a per-click `Idempotency-Key` so a double-click
 * produces at most one state transition.
 */
export async function retryPayout(args: {
  id: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminPayoutView>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<AdminPayoutView>>(
    `/api/admin/payouts/${encodeURIComponent(args.id)}/retry`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { reason: args.reason },
    },
  );
}

export type AdminOrderState =
  | 'pending_payment'
  | 'paid'
  | 'procuring'
  | 'fulfilled'
  | 'failed'
  | 'expired';

/** Admin-shaped row from `/api/admin/orders` (ADR 011 / 015). */
export interface AdminOrderView {
  id: string;
  userId: string;
  merchantId: string;
  state: AdminOrderState;
  currency: string;
  faceValueMinor: string;
  chargeCurrency: string;
  chargeMinor: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  /** `numeric(5,2)` as string (e.g. `"80.00"`). */
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  ctxOrderId: string | null;
  ctxOperatorId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  procuredAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/** Row shape from `/api/admin/users` (admin directory). */
export interface AdminUserRow {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  createdAt: string;
}

/** `GET /api/admin/users` — paginated admin directory with email search. */
export async function listAdminUsers(opts: {
  q?: string;
  limit?: number;
  before?: string;
}): Promise<{ users: AdminUserRow[] }> {
  const params = new URLSearchParams();
  if (opts.q !== undefined && opts.q.length > 0) params.set('q', opts.q);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ users: AdminUserRow[] }>(
    `/api/admin/users${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Full user detail shape from `/api/admin/users/:userId`. */
export interface AdminUserDetail {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  stellarAddress: string | null;
  ctxUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/admin/users/:userId` — single user drill-down. */
export async function getAdminUser(userId: string): Promise<AdminUserDetail> {
  return authenticatedRequest<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(userId)}`);
}

/** One credit-balance row per (user, currency) from `/api/admin/users/:userId/credits`. */
export interface AdminUserCreditRow {
  currency: string;
  balanceMinor: string;
  updatedAt: string;
}

export interface AdminUserCreditsResponse {
  userId: string;
  rows: AdminUserCreditRow[];
}

/** `GET /api/admin/users/:userId/credits` — multi-currency balance drill. */
export async function getAdminUserCredits(userId: string): Promise<AdminUserCreditsResponse> {
  return authenticatedRequest<AdminUserCreditsResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/credits`,
  );
}

/**
 * One row of an admin per-user cashback-by-merchant breakdown.
 * Admin-facing equivalent of the user's own card — same join on
 * `credit_transactions.reference_id::uuid = orders.id`, same
 * ordering, but with the caller resolved from the URL userId.
 */
export interface AdminUserCashbackByMerchantRow {
  merchantId: string;
  cashbackMinor: string;
  orderCount: number;
  lastEarnedAt: string;
}

export interface AdminUserCashbackByMerchantResponse {
  userId: string;
  currency: string;
  since: string;
  rows: AdminUserCashbackByMerchantRow[];
}

/**
 * `GET /api/admin/users/:userId/cashback-by-merchant` — support
 * triage breakdown. Default window 180d (cap 366d); default limit
 * 25 (cap 100).
 */
export async function getAdminUserCashbackByMerchant(
  userId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<AdminUserCashbackByMerchantResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminUserCashbackByMerchantResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-by-merchant${
      qs.length > 0 ? `?${qs}` : ''
    }`,
  );
}

/** Result shape from a successful credit-adjustment write (ADR 017). */
export interface CreditAdjustmentResult {
  id: string;
  userId: string;
  currency: string;
  amountMinor: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

/**
 * `POST /api/admin/users/:userId/credit-adjustments` — ADR 017
 * admin-write. Caller supplies a signed integer minor amount
 * (positive = credit, negative = debit), one of the home currencies
 * (USD/GBP/EUR), and a 2..500 char reason. The service generates the
 * Idempotency-Key so a double-submit of the form can't double-credit.
 */
export async function applyCreditAdjustment(args: {
  userId: string;
  amountMinor: string;
  currency: 'USD' | 'GBP' | 'EUR';
  reason: string;
}): Promise<AdminWriteEnvelope<CreditAdjustmentResult>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<CreditAdjustmentResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/credit-adjustments`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        amountMinor: args.amountMinor,
        currency: args.currency,
        reason: args.reason,
      },
    },
  );
}

export type CreditTransactionType =
  | 'cashback'
  | 'interest'
  | 'spend'
  | 'withdrawal'
  | 'refund'
  | 'adjustment';

/** Row shape from `/api/admin/users/:userId/credit-transactions` (ADR 009). */
export interface AdminCreditTransactionView {
  id: string;
  type: CreditTransactionType;
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/**
 * `GET /api/admin/users/:userId/credit-transactions` — newest-first
 * paginated ledger drill. Cursor via `before=<iso>`; `limit` clamped
 * 1..100 server-side (default 20). Optional `type` filter.
 */
export async function listAdminUserCreditTransactions(opts: {
  userId: string;
  type?: CreditTransactionType;
  before?: string;
  limit?: number;
}): Promise<{ transactions: AdminCreditTransactionView[] }> {
  const params = new URLSearchParams();
  if (opts.type !== undefined) params.set('type', opts.type);
  if (opts.before !== undefined) params.set('before', opts.before);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<{ transactions: AdminCreditTransactionView[] }>(
    `/api/admin/users/${encodeURIComponent(opts.userId)}/credit-transactions${
      qs.length > 0 ? `?${qs}` : ''
    }`,
  );
}

/**
 * `GET /api/admin/orders/:orderId` — single Loop-native order
 * drill-down (ADR 011 / 015). Returns the same shape as a single
 * row from the list endpoint; 404 when the id doesn't match.
 */
export async function getAdminOrder(orderId: string): Promise<AdminOrderView> {
  return authenticatedRequest<AdminOrderView>(`/api/admin/orders/${encodeURIComponent(orderId)}`);
}

/** `GET /api/admin/orders` — paginated, filterable admin view. */
export async function listAdminOrders(opts: {
  state?: AdminOrderState;
  userId?: string;
  merchantId?: string;
  chargeCurrency?: string;
  ctxOperatorId?: string;
  limit?: number;
  before?: string;
}): Promise<{ orders: AdminOrderView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.merchantId !== undefined) params.set('merchantId', opts.merchantId);
  if (opts.chargeCurrency !== undefined) params.set('chargeCurrency', opts.chargeCurrency);
  if (opts.ctxOperatorId !== undefined) params.set('ctxOperatorId', opts.ctxOperatorId);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ orders: AdminOrderView[] }>(
    `/api/admin/orders${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
