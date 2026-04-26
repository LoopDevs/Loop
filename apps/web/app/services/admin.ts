import type {
  AssetCirculationResponse,
  AssetDriftState,
  AssetDriftStateResponse,
  AssetDriftStateRow,
  CashbackRealizationDailyResponse,
  CashbackRealizationDay,
  CashbackRealizationResponse,
  CashbackRealizationRow,
  CreditTransactionType,
  LoopAssetCode,
  LoopLiability,
  OrderState,
  PayoutState,
  MerchantOperatorMixResponse,
  MerchantOperatorMixRow,
  OperatorLatencyResponse,
  OperatorLatencyRow,
  OperatorMerchantMixResponse,
  OperatorMerchantMixRow,
  OperatorStatsResponse,
  OperatorStatsRow,
  SettlementLagResponse,
  SettlementLagRow,
  SupplierSpendActivityDay,
  SupplierSpendActivityResponse,
  SupplierSpendResponse,
  SupplierSpendRow,
  TreasuryCreditFlowDay,
  TreasuryCreditFlowResponse,
  TreasuryHolding,
  TreasuryOrderFlow,
  TreasurySnapshot,
  UserOperatorMixResponse,
  UserOperatorMixRow,
} from '@loop/shared';
export type { CreditTransactionType } from '@loop/shared';
import { authenticatedRequest } from './api-client';

// Re-export so existing `import { LoopAssetCode } from
// '~/services/admin'` callers keep working without every consumer
// learning the `@loop/shared` path. Shared is the source of truth.
export type { LoopAssetCode };

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

/**
 * PUT /api/admin/merchant-cashback-configs/:merchantId — ADR 017
 * admin write (A2-502). Caller supplies the split + a 2..500 char
 * reason; the service generates a per-click `Idempotency-Key` so a
 * double-submit of the form can't apply the edit twice. Response is
 * the standard `{ result, audit }` envelope.
 */
export async function upsertCashbackConfig(
  merchantId: string,
  body: {
    wholesalePct: number;
    userCashbackPct: number;
    loopMarginPct: number;
    active?: boolean;
    reason: string;
  },
): Promise<AdminWriteEnvelope<MerchantCashbackConfig>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<MerchantCashbackConfig>>(
    `/api/admin/merchant-cashback-configs/${encodeURIComponent(merchantId)}`,
    {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    },
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

/**
 * One row from the fleet-wide config-history feed (#580). Extends
 * the per-merchant history row with a resolved display name — the
 * backend joins against the catalog so the admin UI doesn't re-fetch
 * every merchant to render the strip.
 */
export interface AdminConfigHistoryEntry {
  id: string;
  merchantId: string;
  merchantName: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

export interface AdminConfigHistoryResponse {
  history: AdminConfigHistoryEntry[];
}

/**
 * `GET /api/admin/merchant-cashback-configs/history` — newest-first
 * fleet-wide feed of cashback-config edits. Drives the "recent config
 * changes" card on the admin dashboard; complements the per-merchant
 * `cashbackConfigHistory(merchantId)` drill.
 */
export async function getAdminConfigsHistory(
  opts: { limit?: number } = {},
): Promise<AdminConfigHistoryResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminConfigHistoryResponse>(
    `/api/admin/merchant-cashback-configs/history${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Payment-method share response (#585). One entry per
 * `ORDER_PAYMENT_METHODS` value, zero-filled by the backend so the
 * UI layout is stable.
 */
export interface PaymentMethodShareBucket {
  orderCount: number;
  /** Sum of charge_minor for this (state, method) bucket, bigint-as-string. */
  chargeMinor: string;
}

export type AdminPaymentMethod = 'xlm' | 'usdc' | 'credit' | 'loop_asset';

// A2-1166: `AdminOrderState` + `AdminOrderState` used to be two
// hand-maintained copies of the same six-literal union in this file.
// Both were identical to `OrderState` from `@loop/shared`; removing
// the second occurrence here also kept the file in sync with the
// backend CHECK constraint, which reads from the shared tuple.
// The type export at the bottom of this file now re-exports
// `OrderState` under the `AdminOrderState` name for external
// consumers (`UserOrdersTable`, the admin orders route).

export interface PaymentMethodShareResponse {
  state: AdminOrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/**
 * `GET /api/admin/orders/payment-method-share` — cashback-flywheel
 * metric. Tracks which rails users actually pay with; a rising
 * `loop_asset` share is the signal ADR 015's pivot is working.
 * Default `?state=fulfilled`.
 */
export async function getPaymentMethodShare(
  opts: { state?: AdminOrderState } = {},
): Promise<PaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<PaymentMethodShareResponse>(
    `/api/admin/orders/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

// A2-1506: treasury shapes moved to `@loop/shared/admin-treasury.ts` +
// `PayoutState` moved to `@loop/shared/payout-state.ts`. Re-exported
// here via `export type` so the 30+ call sites importing from
// `~/services/admin` don't fan out a rename.
export type { PayoutState, LoopLiability, TreasuryHolding, TreasuryOrderFlow, TreasurySnapshot };

/** GET /api/admin/treasury */
export async function getTreasurySnapshot(): Promise<TreasurySnapshot> {
  return authenticatedRequest<TreasurySnapshot>('/api/admin/treasury');
}

/**
 * Per-asset circulation drift (ADR 015). onChainStroops comes from
 * Horizon /assets; ledgerLiabilityMinor from user_credits. drift =
 * onChain - ledger × 1e5 (1 minor = 1e5 stroops for a 1:1-pinned
 * LOOP asset). Safety-critical metric — non-zero drift that isn't
 * explained by in-flight payouts means something's wrong.
 */
// A2-1506: `AssetCirculationResponse`, `AssetDriftState`,
// `AssetDriftStateRow`, `AssetDriftStateResponse` moved to
// `@loop/shared/admin-assets.ts`. Re-exported via `export type` so
// existing `~/services/admin` call sites keep resolving.
export type {
  AssetCirculationResponse,
  AssetDriftState,
  AssetDriftStateRow,
  AssetDriftStateResponse,
};

/** `GET /api/admin/assets/:assetCode/circulation` */
export async function getAssetCirculation(assetCode: string): Promise<AssetCirculationResponse> {
  return authenticatedRequest<AssetCirculationResponse>(
    `/api/admin/assets/${encodeURIComponent(assetCode)}/circulation`,
  );
}

/** `GET /api/admin/asset-drift/state` */
export async function getAssetDriftState(): Promise<AssetDriftStateResponse> {
  return authenticatedRequest<AssetDriftStateResponse>('/api/admin/asset-drift/state');
}

/**
 * Payout settlement-lag SLA (ADR 015 / 016). Percentile latency in
 * seconds from `pending_payouts` insert → on-chain confirm. Fleet-
 * wide row surfaces with `assetCode: null`; per-asset rows carry
 * the LOOP code. Sample count ships alongside so callers can
 * down-weight low-n rows (p95 of n=1 is noise).
 */
// A2-1506: moved to `@loop/shared/admin-settlement-lag.ts`.
export type { SettlementLagResponse, SettlementLagRow };

/** `GET /api/admin/payouts/settlement-lag?since=...` */
export async function getSettlementLag(sinceIso?: string): Promise<SettlementLagResponse> {
  const qs = sinceIso !== undefined ? `?since=${encodeURIComponent(sinceIso)}` : '';
  return authenticatedRequest<SettlementLagResponse>(`/api/admin/payouts/settlement-lag${qs}`);
}

/**
 * Cashback realization rate (ADR 009 / 015). Per-currency + fleet-
 * wide aggregate (`currency: null`). `recycledBps = spent / earned
 * × 10 000` — the flywheel-health KPI.
 */
// A2-1506: moved to `@loop/shared/admin-cashback-realization.ts`.
export type { CashbackRealizationResponse, CashbackRealizationRow };

/** `GET /api/admin/cashback-realization` */
export async function getCashbackRealization(): Promise<CashbackRealizationResponse> {
  return authenticatedRequest<CashbackRealizationResponse>('/api/admin/cashback-realization');
}

/**
 * Daily cashback-realization trend (ADR 009 / 015). One row per
 * (day, currency); dense (every day in the window has a row) so
 * sparklines don't compress on gap days.
 */
// A2-1506: moved to `@loop/shared/admin-cashback-realization.ts`.
export type { CashbackRealizationDay, CashbackRealizationDailyResponse };

/** `GET /api/admin/cashback-realization/daily?days=N` */
export async function getCashbackRealizationDaily(
  days?: number,
): Promise<CashbackRealizationDailyResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<CashbackRealizationDailyResponse>(
    `/api/admin/cashback-realization/daily${qs}`,
  );
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
// A2-1506: `SupplierSpendRow` / `SupplierSpendResponse` moved to
// `@loop/shared/admin-supplier-spend.ts`. Re-exported for stability.
export type { SupplierSpendRow, SupplierSpendResponse };

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

// A2-1506: `TreasuryCreditFlowDay` / `TreasuryCreditFlowResponse`
// moved to `@loop/shared/admin-treasury.ts` — the shared declaration
// types `currency` as `HomeCurrency | null`, which is the accurate
// wire contract (the handler only returns USD/GBP/EUR and null).
export type { TreasuryCreditFlowDay, TreasuryCreditFlowResponse };

/**
 * `GET /api/admin/treasury/credit-flow` — per-day per-currency
 * ledger delta. Pass `?currency=USD|GBP|EUR` to zero-fill days
 * (stable chart layout).
 */
export async function getTreasuryCreditFlow(
  opts: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' } = {},
): Promise<TreasuryCreditFlowResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.currency !== undefined) params.set('currency', opts.currency);
  const qs = params.toString();
  return authenticatedRequest<TreasuryCreditFlowResponse>(
    `/api/admin/treasury/credit-flow${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-day per-currency supplier-spend activity (ADR 013 / 015). Time-
 * axis of `SupplierSpendRow` — same columns, but bucketed by
 * `fulfilledAt` UTC over the last N days.
 */
// A2-1506: `SupplierSpendActivityDay` / `SupplierSpendActivityResponse`
// moved to `@loop/shared/admin-supplier-spend.ts`.
export type { SupplierSpendActivityDay, SupplierSpendActivityResponse };

/**
 * `GET /api/admin/supplier-spend/activity` — per-day per-currency
 * supplier-spend time-series. Pass `?currency=USD|GBP|EUR` to
 * zero-fill days (stable chart layout).
 */
export async function getSupplierSpendActivity(
  opts: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' } = {},
): Promise<SupplierSpendActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.currency !== undefined) params.set('currency', opts.currency);
  const qs = params.toString();
  return authenticatedRequest<SupplierSpendActivityResponse>(
    `/api/admin/supplier-spend/activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-operator order-count / success-count / failure-count breakdown
 * (ADR 013). Complements `SupplierSpendRow` — spend is "what did we
 * pay CTX this window", operator-stats is "which CTX operator actually
 * carried it". `lastOrderAt` is the newest `createdAt` attributed to
 * this operator in the window.
 */
// A2-1506: moved to `@loop/shared/admin-operator-stats.ts`.
export type { OperatorStatsResponse, OperatorStatsRow };

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
 * Per-merchant × per-operator mix row (ADR 013 / 022). Merchant-
 * scoped sibling of `OperatorStatsRow` — same columns, but rows
 * are operators carrying orders for one specific merchant.
 */
// A2-1506: moved to `@loop/shared/admin-operator-mixes.ts`.
export type { MerchantOperatorMixResponse, MerchantOperatorMixRow };

/**
 * `GET /api/admin/merchants/:merchantId/operator-mix` — for one
 * merchant, which CTX operators are carrying its orders. Default
 * window 24h; server clamps `?since=` at 366d.
 */
export async function getMerchantOperatorMix(
  merchantId: string,
  opts: { since?: string } = {},
): Promise<MerchantOperatorMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<MerchantOperatorMixResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/operator-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-operator × per-merchant mix row (ADR 013 / 022). Dual of
 * `MerchantOperatorMixRow` — operator-scoped rather than merchant-
 * scoped. Used for CTX capacity reviews: "which merchants is this
 * operator carrying?".
 */
// A2-1506: moved to `@loop/shared/admin-operator-mixes.ts`.
export type { OperatorMerchantMixResponse, OperatorMerchantMixRow };

/**
 * `GET /api/admin/operators/:operatorId/merchant-mix` — for one
 * operator, which merchants are they carrying. Default window
 * 24h; server clamps `?since=` at 366d.
 */
export async function getOperatorMerchantMix(
  operatorId: string,
  opts: { since?: string } = {},
): Promise<OperatorMerchantMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorMerchantMixResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/merchant-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-user × per-operator mix row (ADR 013 / 022). Third corner of
 * the mix-axis matrix. Used for support triage — "user X's slow
 * cashback correlates with op-beta-02, which has a failing
 * circuit".
 */
// A2-1506: moved to `@loop/shared/admin-operator-mixes.ts`.
export type { UserOperatorMixResponse, UserOperatorMixRow };

/**
 * `GET /api/admin/users/:userId/operator-mix` — for one user,
 * which CTX operators have carried their orders. Default window
 * 24h; server clamps `?since=` at 366d.
 */
export async function getUserOperatorMix(
  userId: string,
  opts: { since?: string } = {},
): Promise<UserOperatorMixResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<UserOperatorMixResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/operator-mix${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Per-operator fulfilment latency row (ADR 013 / 022). One row per
 * operator that had at least one fulfilled order in the window.
 * Percentiles are reported in ms and rounded.
 */
// A2-1506: moved to `@loop/shared/admin-operator-stats.ts`.
export type { OperatorLatencyResponse, OperatorLatencyRow };

/**
 * `GET /api/admin/operators/latency` — fleet per-operator p50/p95/p99
 * of `fulfilledAt - paidAt`. Default window 24h; server clamps 366d.
 */
export async function getOperatorLatency(
  opts: { since?: string } = {},
): Promise<OperatorLatencyResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorLatencyResponse>(
    `/api/admin/operators/latency${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Per-operator per-currency supplier-spend row. Same shape as the
 *  fleet SupplierSpendRow — reused here so the drill page table
 *  doesn't duplicate the type. */
export interface OperatorSupplierSpendResponse {
  operatorId: string;
  since: string;
  rows: SupplierSpendRow[];
}

/**
 * `GET /api/admin/operators/:operatorId/supplier-spend` — per-currency
 * supplier-spend scoped to one operator. Default window 24h; server
 * clamps 366d.
 */
export async function getOperatorSupplierSpend(
  operatorId: string,
  opts: { since?: string } = {},
): Promise<OperatorSupplierSpendResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorSupplierSpendResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/supplier-spend${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Per-operator daily activity row. */
export interface OperatorActivityDay {
  day: string;
  created: number;
  fulfilled: number;
  failed: number;
}

export interface OperatorActivityResponse {
  operatorId: string;
  windowDays: number;
  days: OperatorActivityDay[];
}

/**
 * `GET /api/admin/operators/:operatorId/activity` — per-day
 * created/fulfilled/failed for one operator over `?days=1-90`
 * (default 7). Response is zero-filled by the backend so a stable
 * N-row chart layout is guaranteed.
 */
export async function getOperatorActivity(
  operatorId: string,
  opts: { days?: number } = {},
): Promise<OperatorActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  const qs = params.toString();
  return authenticatedRequest<OperatorActivityResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/activity${qs.length > 0 ? `?${qs}` : ''}`,
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
  /** Distinct users who earned from this merchant in the window. */
  uniqueUserCount: number;
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

/**
 * One row of the per-merchant flywheel leaderboard (#602). Ranks
 * merchants by how many of their fulfilled orders came through the
 * LOOP-asset rail (recycled cashback). Merchants with zero recycled
 * orders are omitted server-side — this is explicitly a "who's
 * recycling" list, not a zero-inflated fleet enumeration.
 */
export interface MerchantFlywheelShareRow {
  merchantId: string;
  totalFulfilledCount: number;
  recycledOrderCount: number;
  recycledChargeMinor: string;
  totalChargeMinor: string;
}

export interface MerchantsFlywheelShareResponse {
  since: string;
  rows: MerchantFlywheelShareRow[];
}

/**
 * `GET /api/admin/merchants/flywheel-share` — merchant-axis flywheel
 * leaderboard. Default 31d window (cap 366d), default limit 25 (cap
 * 100). Sorted by recycled-count desc.
 */
export async function getAdminMerchantsFlywheelShare(
  opts: { since?: string; limit?: number } = {},
): Promise<MerchantsFlywheelShareResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<MerchantsFlywheelShareResponse>(
    `/api/admin/merchants/flywheel-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Single stuck-order row from `/api/admin/stuck-orders` (ADR 011/013). */
export interface StuckOrderRow {
  id: string;
  userId: string;
  merchantId: string;
  state: string;
  /** Payment rail the user chose (ADR 015). Matters for triage — a
   * stuck loop_asset order is a flywheel-path incident; a stuck
   * xlm/usdc is a Stellar-watcher incident; a stuck credit is an
   * off-ledger state-machine bug. */
  paymentMethod: string;
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

/**
 * One day of confirmed-payout activity (#637). Settlement-side
 * sibling of `CashbackActivityDay`. `byAsset` is empty on zero
 * days so the UI can render gaps without an extra count branch.
 */
export interface PerAssetPayoutAmount {
  assetCode: string;
  /** SUM(amount_stroops) on this day. bigint-as-string. */
  stroops: string;
  count: number;
}

export interface PayoutsActivityDay {
  day: string;
  count: number;
  byAsset: PerAssetPayoutAmount[];
}

export interface PayoutsActivityResponse {
  days: number;
  rows: PayoutsActivityDay[];
}

/** `GET /api/admin/payouts-activity` — N-day confirmed-payout series (default 30, max 180). */
export async function getPayoutsActivity(days?: number): Promise<PayoutsActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<PayoutsActivityResponse>(`/api/admin/payouts-activity${qs}`);
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
  /** ADR-024 §2 — filter by payout discriminator (order-cashback vs withdrawal). */
  kind?: 'order_cashback' | 'withdrawal';
  limit?: number;
  before?: string;
}): Promise<{ payouts: AdminPayoutView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.assetCode !== undefined) params.set('assetCode', opts.assetCode);
  if (opts.kind !== undefined) params.set('kind', opts.kind);
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

// A2-1166: re-export of `OrderState` from `@loop/shared`, which is
// the single source of truth for the order state machine (ADR 010 +
// backend CHECK constraint). The `AdminOrderState` name is kept so
// existing consumers — `UserOrdersTable`, admin orders routes — don't
// need to re-import.
export type AdminOrderState = OrderState;

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

/**
 * `GET /api/admin/users/by-email?email=` — exact-match lookup. Support
 * pastes the full email address and gets the user row in one request.
 * Complements the fragment search on `/api/admin/users?q=` (ILIKE-based,
 * paginated) — this one does exact equality against a lowercase-normalised
 * form so `Alice@Example.COM` matches `alice@example.com`. Throws on 404 /
 * 500 via the shared ApiException path; handlers render "no user with that
 * email" for 404.
 */
export async function getAdminUserByEmail(email: string): Promise<AdminUserDetail> {
  return authenticatedRequest<AdminUserDetail>(
    `/api/admin/users/by-email?email=${encodeURIComponent(email)}`,
  );
}

/** One entry in the top-users-by-pending-payout leaderboard. */
export interface TopUserByPendingPayoutEntry {
  userId: string;
  email: string;
  /** LOOP asset code (USDLOOP / GBPLOOP / EURLOOP). */
  assetCode: string;
  /** Summed in-flight payout amount, stroops as bigint-string. */
  totalStroops: string;
  /** Number of payout rows contributing to totalStroops. */
  payoutCount: number;
}

export interface TopUsersByPendingPayoutResponse {
  entries: TopUserByPendingPayoutEntry[];
}

/**
 * `GET /api/admin/users/top-by-pending-payout?limit=` — ranked users
 * with the most in-flight (pending + submitted) on-chain payout debt,
 * grouped by (user, asset). Drives ops funding prioritisation on the
 * treasury page: "who's owed the most USDLOOP right now?" is the first
 * question before topping up an operator reserve.
 */
export async function getTopUsersByPendingPayout(
  opts: { limit?: number } = {},
): Promise<TopUsersByPendingPayoutResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<TopUsersByPendingPayoutResponse>(
    `/api/admin/users/top-by-pending-payout${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * One row of the 90-day users-recycling-activity leaderboard (#611).
 * Ranked by most-recent loop_asset order; zero-recycle users are
 * omitted server-side. `recycledChargeMinor` is bigint-as-string
 * (fleet-wide precision can push past 2^53).
 */
export interface UserRecyclingActivityRow {
  userId: string;
  email: string;
  lastRecycledAt: string;
  recycledOrderCount: number;
  recycledChargeMinor: string;
  currency: string;
}

export interface UsersRecyclingActivityResponse {
  since: string;
  rows: UserRecyclingActivityRow[];
}

/**
 * `GET /api/admin/users/recycling-activity?limit=` — 90-day list of
 * users with at least one loop_asset order, sorted by most-recent
 * recycle. Complements `/top-users` (by cashback earned) and
 * `/top-by-pending-payout` (by backlog).
 */
export async function getAdminUsersRecyclingActivity(
  opts: { limit?: number } = {},
): Promise<UsersRecyclingActivityResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<UsersRecyclingActivityResponse>(
    `/api/admin/users/recycling-activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Response shape from POST /api/admin/merchants/resync. */
export interface AdminMerchantResyncResponse {
  /** Merchant count after the sweep (not delta vs. pre-sync). */
  merchantCount: number;
  /** ISO-8601 of the currently-loaded snapshot. */
  loadedAt: string;
  /** Whether THIS call advanced the store (vs. coalesced with an in-flight sweep). */
  triggered: boolean;
}

/**
 * `POST /api/admin/merchants/resync` — force an immediate CTX catalog
 * sweep (ADR 011 / ADR 017). Bypasses the 6h scheduled refresh so a
 * merchant change lands within seconds. A2-509 made the endpoint
 * ADR-017 compliant: caller supplies a reason, the service generates
 * a per-click Idempotency-Key, and the backend returns the standard
 * `{ result, audit }` envelope. Two admins clicking simultaneously
 * coalesce into one upstream sweep via the backend mutex (one response
 * carries `triggered: true`, the other `triggered: false` with the
 * same post-sync `loadedAt`). 502 on upstream failure; cached snapshot
 * is retained.
 */
export async function resyncMerchants(args: {
  reason: string;
}): Promise<AdminWriteEnvelope<AdminMerchantResyncResponse>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<AdminMerchantResyncResponse>>(
    '/api/admin/merchants/resync',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { reason: args.reason },
    },
  );
}

/** One notifier in the Discord catalog (ADR 018 / #572). */
export interface AdminDiscordNotifier {
  name: string;
  channel: 'orders' | 'monitoring' | 'admin-audit';
  description: string;
}

export interface AdminDiscordNotifiersResponse {
  notifiers: AdminDiscordNotifier[];
}

/**
 * `GET /api/admin/discord/notifiers` — static read of the backend's
 * `DISCORD_NOTIFIERS` const. Zero DB, no secrets (`channel` is the
 * symbolic name, not the webhook URL). Admin UI renders "what
 * signals can this system send us?" from this list.
 */
export async function getAdminDiscordNotifiers(): Promise<AdminDiscordNotifiersResponse> {
  return authenticatedRequest<AdminDiscordNotifiersResponse>('/api/admin/discord/notifiers');
}

/** Channel enum for the test-ping endpoint. Same union as AdminDiscordNotifier.channel. */
export type AdminDiscordChannel = AdminDiscordNotifier['channel'];

export interface AdminDiscordTestResponse {
  status: 'delivered';
  channel: AdminDiscordChannel;
}

/**
 * `POST /api/admin/discord/test` — fires a benign test ping at the
 * chosen channel's webhook. Ops uses this after rotating env vars or
 * redeploying to prove end-to-end wiring without waiting for a real
 * event. 409 WEBHOOK_NOT_CONFIGURED when the channel's env var is
 * unset; the UI surfaces that distinctly from a silent success.
 */
export async function testDiscordChannel(
  channel: AdminDiscordChannel,
): Promise<AdminDiscordTestResponse> {
  return authenticatedRequest<AdminDiscordTestResponse>('/api/admin/discord/test', {
    method: 'POST',
    body: { channel },
  });
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
 * Admin per-user cashback scalar (ADR 009 / 015). Admin-facing mirror
 * of `/api/users/me/cashback-summary` — lifetime + this-month cashback
 * earned, scoped to the user's current `home_currency`. Drives the
 * compact "£42 lifetime · £3.20 this month" chip on the admin drill-
 * down.
 */
export interface AdminUserCashbackSummary {
  userId: string;
  currency: string;
  lifetimeMinor: string;
  thisMonthMinor: string;
}

/** `GET /api/admin/users/:userId/cashback-summary` — scalar headline. */
export async function getAdminUserCashbackSummary(
  userId: string,
): Promise<AdminUserCashbackSummary> {
  return authenticatedRequest<AdminUserCashbackSummary>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-summary`,
  );
}

/**
 * Admin per-user flywheel scalar (#600). Mirrors the user-facing
 * `/flywheel-stats` endpoint shape. Scoped to the target user's
 * current home_currency (numerator + denominator share a
 * denomination).
 */
export interface AdminUserFlywheelStats {
  userId: string;
  currency: string;
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders. bigint-as-string. */
  recycledChargeMinor: string;
  totalFulfilledCount: number;
  /** SUM(charge_minor) over every fulfilled order in home_currency. bigint-as-string. */
  totalFulfilledChargeMinor: string;
}

/** `GET /api/admin/users/:userId/flywheel-stats` — per-user recycled-vs-total. */
export async function getAdminUserFlywheelStats(userId: string): Promise<AdminUserFlywheelStats> {
  return authenticatedRequest<AdminUserFlywheelStats>(
    `/api/admin/users/${encodeURIComponent(userId)}/flywheel-stats`,
  );
}

/**
 * Admin per-merchant flywheel scalar (#623). Sibling of the per-user
 * variant above, but scoped to a merchant's 31-day fulfilled volume.
 *
 * No `currency` field — per-merchant volume can span multiple user
 * home_currencies, so charges are summed without a common
 * denomination. The chip renders by count + percentage only.
 */
export interface AdminMerchantFlywheelStats {
  merchantId: string;
  /** ISO-8601 start of the 31-day window. */
  since: string;
  totalFulfilledCount: number;
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders. bigint-as-string. */
  recycledChargeMinor: string;
  /** SUM(charge_minor) over every fulfilled order. bigint-as-string. */
  totalChargeMinor: string;
}

/** `GET /api/admin/merchants/:merchantId/flywheel-stats` — per-merchant recycled-vs-total. */
export async function getAdminMerchantFlywheelStats(
  merchantId: string,
): Promise<AdminMerchantFlywheelStats> {
  return authenticatedRequest<AdminMerchantFlywheelStats>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/flywheel-stats`,
  );
}

/**
 * Admin per-merchant cashback-summary (#625). Per-currency
 * breakdown of `user_cashback_minor` summed over the merchant's
 * fulfilled orders.
 *
 * Per-currency instead of one total because a merchant's volume
 * spans user home_currencies, so there's no coherent denomination
 * for a rolled-up aggregate. Each bucket carries context for
 * "cashback as % of spend" (`lifetimeChargeMinor`).
 */
export interface AdminMerchantCashbackCurrencyBucket {
  currency: string;
  fulfilledCount: number;
  /** SUM(user_cashback_minor) over fulfilled orders in this currency. bigint-as-string. */
  lifetimeCashbackMinor: string;
  /** SUM(charge_minor) in this currency — "cashback as % of spend" denominator. */
  lifetimeChargeMinor: string;
}

export interface AdminMerchantCashbackSummary {
  merchantId: string;
  totalFulfilledCount: number;
  /** Sorted desc by fulfilledCount. Empty for zero-volume merchants (not 404). */
  currencies: AdminMerchantCashbackCurrencyBucket[];
}

/** `GET /api/admin/merchants/:merchantId/cashback-summary` — per-currency cashback paid out. */
export async function getAdminMerchantCashbackSummary(
  merchantId: string,
): Promise<AdminMerchantCashbackSummary> {
  return authenticatedRequest<AdminMerchantCashbackSummary>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/cashback-summary`,
  );
}

/**
 * Admin per-merchant payment-method share (#627). Merchant-scoped
 * mirror of `PaymentMethodShareResponse` — same `byMethod` shape,
 * filtered via `WHERE merchant_id = :merchantId`.
 */
export interface AdminMerchantPaymentMethodShareResponse {
  merchantId: string;
  state: AdminOrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/** `GET /api/admin/merchants/:merchantId/payment-method-share` — rail mix for one merchant. */
export async function getAdminMerchantPaymentMethodShare(
  merchantId: string,
  opts: { state?: AdminOrderState } = {},
): Promise<AdminMerchantPaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<AdminMerchantPaymentMethodShareResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Admin per-user payment-method share (#629). User-scoped third
 * sibling of the fleet + per-merchant rail-mix shapes. Same
 * `byMethod` record + zero-filled buckets.
 */
export interface AdminUserPaymentMethodShareResponse {
  userId: string;
  state: AdminOrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/** `GET /api/admin/users/:userId/payment-method-share` — rail mix for one user. */
export async function getAdminUserPaymentMethodShare(
  userId: string,
  opts: { state?: AdminOrderState } = {},
): Promise<AdminUserPaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<AdminUserPaymentMethodShareResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Fleet-wide cashback-monthly entry (#592). Identical shape to the
 * user-facing `CashbackMonthlyEntry` by design — the admin chart
 * re-uses the same bar-rendering helpers. One entry per
 * (month, currency) pair; oldest-first ordering.
 */
export interface AdminCashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface AdminCashbackMonthlyResponse {
  entries: AdminCashbackMonthlyEntry[];
}

/**
 * `GET /api/admin/cashback-monthly` — 12-month fleet-wide cashback
 * emissions grouped by (month, currency). Drives the monthly bar
 * chart on `/admin/treasury`.
 */
export async function getAdminCashbackMonthly(): Promise<AdminCashbackMonthlyResponse> {
  return authenticatedRequest<AdminCashbackMonthlyResponse>('/api/admin/cashback-monthly');
}

/**
 * Settlement-side sibling of `AdminCashbackMonthlyEntry` (#631).
 * Confirmed on-chain payouts grouped by (month, assetCode).
 * Stroops rather than fiat minor units because `pending_payouts`
 * pins the Stellar-native amount — the UI converts via the
 * `stroops / 1e5 = minor` factor pinned in `credits/payout-
 * builder.ts`.
 */
export interface AdminPayoutsMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  /** LOOP asset code — USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
  /** SUM(amount_stroops) of confirmed payouts. bigint-as-string. */
  paidStroops: string;
  payoutCount: number;
}

export interface AdminPayoutsMonthlyResponse {
  entries: AdminPayoutsMonthlyEntry[];
}

/** `GET /api/admin/payouts-monthly` — 12-month fleet-wide confirmed payouts by (month, assetCode). */
export async function getAdminPayoutsMonthly(): Promise<AdminPayoutsMonthlyResponse> {
  return authenticatedRequest<AdminPayoutsMonthlyResponse>('/api/admin/payouts-monthly');
}

/**
 * Per-user cashback-monthly response (#633). Same entry shape as
 * the fleet-wide `AdminCashbackMonthlyEntry` — the chart primitive
 * in `MonthlyCashbackChart` accepts either.
 */
export interface AdminUserCashbackMonthlyEntry {
  month: string;
  currency: string;
  cashbackMinor: string;
}

export interface AdminUserCashbackMonthlyResponse {
  userId: string;
  entries: AdminUserCashbackMonthlyEntry[];
}

/** `GET /api/admin/users/:userId/cashback-monthly` — 12-month trend for one user. */
export async function getAdminUserCashbackMonthly(
  userId: string,
): Promise<AdminUserCashbackMonthlyResponse> {
  return authenticatedRequest<AdminUserCashbackMonthlyResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-monthly`,
  );
}

/**
 * Per-merchant cashback-monthly response (#635). Same entry
 * shape as the per-user and fleet variants; `currency` here is
 * the order's `charge_currency` (the user's home_currency at
 * order-creation time).
 */
export interface AdminMerchantCashbackMonthlyEntry {
  month: string;
  currency: string;
  cashbackMinor: string;
}

export interface AdminMerchantCashbackMonthlyResponse {
  merchantId: string;
  entries: AdminMerchantCashbackMonthlyEntry[];
}

/** `GET /api/admin/merchants/:merchantId/cashback-monthly` — 12-month trend for one merchant. */
export async function getAdminMerchantCashbackMonthly(
  merchantId: string,
): Promise<AdminMerchantCashbackMonthlyResponse> {
  return authenticatedRequest<AdminMerchantCashbackMonthlyResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/cashback-monthly`,
  );
}

/**
 * One day of merchant flywheel activity (#641). Time-axis
 * companion to the scalar `AdminMerchantFlywheelStats` — same
 * merchant, same 31-day window (or whatever `?days` asked for),
 * but one row per day so the UI can render a trajectory.
 */
export interface MerchantFlywheelActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  recycledCount: number;
  totalCount: number;
  /** bigint-as-string. */
  recycledChargeMinor: string;
  /** bigint-as-string. */
  totalChargeMinor: string;
}

export interface AdminMerchantFlywheelActivityResponse {
  merchantId: string;
  days: number;
  rows: MerchantFlywheelActivityDay[];
}

/** `GET /api/admin/merchants/:merchantId/flywheel-activity` — daily flywheel timeseries. */
export async function getAdminMerchantFlywheelActivity(
  merchantId: string,
  days?: number,
): Promise<AdminMerchantFlywheelActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<AdminMerchantFlywheelActivityResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/flywheel-activity${qs}`,
  );
}

/**
 * Per-merchant top-earners row (#655). One entry per
 * (user, charge_currency) pair — a user can appear twice if
 * they've fulfilled orders at the merchant in two currencies.
 */
export interface MerchantTopEarnerRow {
  userId: string;
  email: string;
  currency: string;
  orderCount: number;
  /** SUM(user_cashback_minor) for this (user, currency). bigint-as-string. */
  cashbackMinor: string;
  /** SUM(charge_minor) — context for "cashback as % of their spend". */
  chargeMinor: string;
}

export interface AdminMerchantTopEarnersResponse {
  merchantId: string;
  since: string;
  rows: MerchantTopEarnerRow[];
}

/** `GET /api/admin/merchants/:merchantId/top-earners` — ranked top cashback earners at one merchant. */
export async function getAdminMerchantTopEarners(
  merchantId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<AdminMerchantTopEarnersResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminMerchantTopEarnersResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/top-earners${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * Admin payment-method activity day (#594). One row per UTC day in
 * the requested window (default 30, cap 90), with fulfilled-order
 * counts per rail. Every rail is always present — the backend pre-
 * seeds zero buckets — so the chart component doesn't gap-fill.
 */
export interface PaymentMethodActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  byMethod: Record<AdminPaymentMethod, number>;
}

export interface AdminPaymentMethodActivityResponse {
  /** Oldest-first so the chart renders left-to-right. */
  days: PaymentMethodActivityDay[];
  windowDays: number;
}

/**
 * `GET /api/admin/orders/payment-method-activity` — daily payment-
 * method time-series. Trend complement to the scalar share card:
 * share answers "where are we now", this one answers "where are we
 * going".
 */
export async function getAdminPaymentMethodActivity(
  opts: { days?: number } = {},
): Promise<AdminPaymentMethodActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  const qs = params.toString();
  return authenticatedRequest<AdminPaymentMethodActivityResponse>(
    `/api/admin/orders/payment-method-activity${qs.length > 0 ? `?${qs}` : ''}`,
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

/** Result shape from a successful admin withdrawal (ADR 024). */
export interface WithdrawalResult {
  id: string;
  payoutId: string;
  userId: string;
  currency: string;
  amountMinor: string;
  destinationAddress: string;
  priorBalanceMinor: string;
  newBalanceMinor: string;
  createdAt: string;
}

/**
 * `POST /api/admin/users/:userId/withdrawals` — ADR 024 admin-write.
 * Debits the user's off-chain cashback balance and queues a matching
 * on-chain LOOP-asset payout. Caller supplies a positive minor amount,
 * one of the home currencies (USD/GBP/EUR), the user's Stellar
 * destination address, and a 2..500 char reason. The service generates
 * the Idempotency-Key so a double-submit can't double-debit.
 */
export async function applyAdminWithdrawal(args: {
  userId: string;
  amountMinor: string;
  currency: 'USD' | 'GBP' | 'EUR';
  destinationAddress: string;
  reason: string;
}): Promise<AdminWriteEnvelope<WithdrawalResult>> {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return authenticatedRequest<AdminWriteEnvelope<WithdrawalResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/withdrawals`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        amountMinor: args.amountMinor,
        currency: args.currency,
        destinationAddress: args.destinationAddress,
        reason: args.reason,
      },
    },
  );
}

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
  paymentMethod?: AdminPaymentMethod;
  ctxOperatorId?: string;
  limit?: number;
  before?: string;
}): Promise<{ orders: AdminOrderView[] }> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  if (opts.userId !== undefined) params.set('userId', opts.userId);
  if (opts.merchantId !== undefined) params.set('merchantId', opts.merchantId);
  if (opts.chargeCurrency !== undefined) params.set('chargeCurrency', opts.chargeCurrency);
  if (opts.paymentMethod !== undefined) params.set('paymentMethod', opts.paymentMethod);
  if (opts.ctxOperatorId !== undefined) params.set('ctxOperatorId', opts.ctxOperatorId);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<{ orders: AdminOrderView[] }>(
    `/api/admin/orders${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * One bucket of fulfilled-order flow, grouped by (merchantId,
 * chargeCurrency). Rendered on /admin/cashback below each row so ops
 * can compare configured split to actual lifetime money movement.
 */
export interface MerchantFlow {
  merchantId: string;
  currency: string;
  count: string;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

/** `GET /api/admin/merchant-flows` — per-merchant fulfilled-order flows. */
export async function listMerchantFlows(): Promise<{ flows: MerchantFlow[] }> {
  return authenticatedRequest<{ flows: MerchantFlow[] }>(`/api/admin/merchant-flows`);
}
