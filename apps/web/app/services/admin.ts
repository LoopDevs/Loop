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

/** `POST /api/admin/payouts/:id/retry` — flips a failed row back to pending. */
export async function retryPayout(id: string): Promise<AdminPayoutView> {
  return authenticatedRequest<AdminPayoutView>(
    `/api/admin/payouts/${encodeURIComponent(id)}/retry`,
    { method: 'POST' },
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

/**
 * Admin one-shot user summary (ADR 011 / 015). The admin UI clicks
 * a userId from /admin/orders or /admin/payouts and lands on
 * /admin/users/:userId — this fetch powers that page's top card.
 * Paginated order + payout lists are still queried separately via
 * the existing `/api/admin/orders?userId=` and `/api/admin/payouts?userId=`
 * endpoints so this call stays fast.
 */
export interface AdminUserView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  stellarAddress: string | null;
  createdAt: string;
  /** Off-chain balance in home-currency minor units. BigInt-string. */
  balanceMinor: string;
  /** Lifetime sum of cashback credits. Excludes withdrawals; BigInt-string. */
  lifetimeCashbackEarnedMinor: string;
  /** Total orders across every state. BigInt-string count. */
  orderCount: string;
  /** pending_payouts rows in pending or submitted state. BigInt-string. */
  pendingPayoutCount: string;
}

/** `GET /api/admin/users/:userId` — admin user drill-down summary. */
export async function getAdminUser(userId: string): Promise<{ user: AdminUserView }> {
  return authenticatedRequest<{ user: AdminUserView }>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
  );
}

/**
 * Audit view of a support-initiated credit adjustment (ADR 009 / 011).
 * Signed `amountMinor` — positive credit, negative debit.
 */
export interface CreditAdjustmentEntry {
  id: string;
  userId: string;
  type: 'adjustment';
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  /** The admin's user id — audit trail. */
  referenceId: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreditAdjustmentResponse {
  entry: CreditAdjustmentEntry;
  balance: { currency: string; balanceMinor: string };
}

/**
 * `POST /api/admin/users/:userId/credit-adjustments` — support action
 * that writes a signed adjustment to the ledger and updates
 * `user_credits.balance_minor` atomically. Rejected when the debit
 * would push the balance below zero (409 INSUFFICIENT_BALANCE).
 */
export async function createCreditAdjustment(
  userId: string,
  body: { amountMinor: string; currency: 'USD' | 'GBP' | 'EUR'; note: string },
): Promise<CreditAdjustmentResponse> {
  return authenticatedRequest<CreditAdjustmentResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/credit-adjustments`,
    { method: 'POST', body },
  );
}
