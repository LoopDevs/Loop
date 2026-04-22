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
  limit?: number;
  before?: string;
}): Promise<{ payouts: AdminPayoutView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ payouts: AdminPayoutView[] }>(
    `/api/admin/payouts${qs.length > 0 ? `?${qs}` : ''}`,
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

/** `GET /api/admin/orders` — paginated, filterable admin view. */
export async function listAdminOrders(opts: {
  state?: AdminOrderState;
  userId?: string;
  limit?: number;
  before?: string;
}): Promise<{ orders: AdminOrderView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ orders: AdminOrderView[] }>(
    `/api/admin/orders${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
