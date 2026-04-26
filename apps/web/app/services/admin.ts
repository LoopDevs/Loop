import type {
  CreditTransactionType,
  LoopAssetCode,
  OrderState,
  PayoutState,
  SettlementLagResponse,
  SettlementLagRow,
} from '@loop/shared';
export type { CreditTransactionType } from '@loop/shared';
import type { AdminPaymentMethod } from './admin-payment-method-share';
import type { AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

// Re-export so existing `import { LoopAssetCode } from
// '~/services/admin'` callers keep working without every consumer
// learning the `@loop/shared` path. Shared is the source of truth.
export type { LoopAssetCode };

// A2-1165 (slice 20): cashback-config quartet (list + upsert +
// per-merchant history + fleet history) moved to
// `./admin-cashback-config.ts`. The split is the central knob the
// admin panel exists to turn (ADR 011 / 017). Inline shapes
// moved with the functions — no other consumers. Re-export keeps
// `MerchantConfigEditor.tsx`, `ConfigHistoryStrip.tsx`,
// `routes/admin.merchants.$merchantId.tsx`, and paired tests
// untouched.
export {
  type MerchantCashbackConfig,
  type MerchantCashbackConfigHistoryEntry,
  type AdminConfigHistoryEntry,
  type AdminConfigHistoryResponse,
  listCashbackConfigs,
  upsertCashbackConfig,
  cashbackConfigHistory,
  getAdminConfigsHistory,
} from './admin-cashback-config';

// A2-1165 (slice 13): payment-method-share trio (fleet + per-
// merchant + per-user, ADR 023 mix-axis pattern) moved to
// `./admin-payment-method-share.ts`. Inline shapes moved with the
// functions — no other consumers. The barrel re-export below
// covers all three reads + 5 type re-exports.
//
// A2-1166: `AdminOrderState` + `AdminOrderState` used to be two
// hand-maintained copies of the same six-literal union in this file.
// Both were identical to `OrderState` from `@loop/shared`. The
// extracted slice imports `OrderState` directly; the type export
// at the bottom of this file still re-exports it under the
// `AdminOrderState` name for external consumers (`UserOrdersTable`,
// the admin orders route).
export {
  type PaymentMethodShareBucket,
  type AdminPaymentMethod,
  type PaymentMethodShareResponse,
  type AdminMerchantPaymentMethodShareResponse,
  type AdminUserPaymentMethodShareResponse,
  getPaymentMethodShare,
  getAdminMerchantPaymentMethodShare,
  getAdminUserPaymentMethodShare,
} from './admin-payment-method-share';

// A2-1165 (slice 4): treasury surface extracted to
// `./admin-treasury.ts`. Type definitions remain canonical in
// `@loop/shared/admin-treasury.ts` (per A2-1506). Re-export here
// keeps existing consumers (AdminNav, CreditFlowChart, the
// admin.assets routes + tests) untouched.
export {
  type PayoutState,
  type LoopLiability,
  type TreasuryHolding,
  type TreasuryOrderFlow,
  type TreasurySnapshot,
  type TreasuryCreditFlowDay,
  type TreasuryCreditFlowResponse,
  getTreasurySnapshot,
  getTreasuryCreditFlow,
} from './admin-treasury';

/**
 * Per-asset circulation drift (ADR 015). onChainStroops comes from
 * Horizon /assets; ledgerLiabilityMinor from user_credits. drift =
 * onChain - ledger × 1e5 (1 minor = 1e5 stroops for a 1:1-pinned
 * LOOP asset). Safety-critical metric — non-zero drift that isn't
 * explained by in-flight payouts means something's wrong.
 */
// A2-1165 (slice 3): asset-circulation + asset-drift extracted to
// `./admin-assets.ts`. Type definitions remain canonical in
// `@loop/shared/admin-assets.ts` (per A2-1506); the new file
// re-exports them alongside the two read endpoints. Re-export here
// keeps existing consumers (AssetCirculationCard.tsx, AssetDriftBadge
// .tsx, AssetDriftWatcherCard.tsx, routes/admin.assets.tsx + paired
// tests) untouched.
export {
  type AssetCirculationResponse,
  type AssetDriftState,
  type AssetDriftStateRow,
  type AssetDriftStateResponse,
  getAssetCirculation,
  getAssetDriftState,
} from './admin-assets';

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

// A2-1165 (slice 5): cashback-realization surface (snapshot + daily)
// extracted to `./admin-cashback-realization.ts`. Type definitions
// remain canonical in `@loop/shared/admin-cashback-realization.ts`
// (per A2-1506). Re-export keeps CashbackRealizationCard.tsx,
// RealizationSparkline.tsx, and both paired tests untouched.
export {
  type CashbackRealizationResponse,
  type CashbackRealizationRow,
  type CashbackRealizationDay,
  type CashbackRealizationDailyResponse,
  getCashbackRealization,
  getCashbackRealizationDaily,
} from './admin-cashback-realization';

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

// A2-1165 (slice 6): supplier-spend surface (snapshot + activity
// time-series) extracted to `./admin-supplier-spend.ts`. Type
// definitions remain canonical in
// `@loop/shared/admin-supplier-spend.ts` (per A2-1506). Re-export
// keeps SupplierSpendCard.tsx, SupplierSpendActivityCard.tsx, and
// `routes/admin.supplier-spend.tsx` untouched.
export {
  type SupplierSpendRow,
  type SupplierSpendResponse,
  type SupplierSpendActivityDay,
  type SupplierSpendActivityResponse,
  getSupplierSpend,
  getSupplierSpendActivity,
} from './admin-supplier-spend';

// A2-1165 (slice 8): operator-stats + operator-latency moved to
// `./admin-operator-stats.ts`. Type definitions remain canonical
// in `@loop/shared/admin-operator-stats.ts` (per A2-1506). The
// barrel re-export at the operator-latency anchor below covers
// both reads + 4 type re-exports.

// A2-1165 (slice 7): operator mix-axis matrix (ADR 023) extracted
// to `./admin-operator-mixes.ts`. Type definitions remain canonical
// in `@loop/shared/admin-operator-mixes.ts` (per A2-1506). Re-
// export keeps the merchant / operator / user drill pages and
// their paired tests untouched.
export {
  type MerchantOperatorMixResponse,
  type MerchantOperatorMixRow,
  type OperatorMerchantMixResponse,
  type OperatorMerchantMixRow,
  type UserOperatorMixResponse,
  type UserOperatorMixRow,
  getMerchantOperatorMix,
  getOperatorMerchantMix,
  getUserOperatorMix,
} from './admin-operator-mixes';

// A2-1165 (slice 8): the operator-stats + operator-latency surface
// (paired ADR 013 fleet-of-CTX-operators reads) lives in
// `./admin-operator-stats.ts`. Re-export keeps OperatorStatsCard,
// OperatorLatencyCard, routes/admin.operators.tsx, and paired
// tests untouched.
export {
  type OperatorStatsResponse,
  type OperatorStatsRow,
  type OperatorLatencyResponse,
  type OperatorLatencyRow,
  getOperatorStats,
  getOperatorLatency,
} from './admin-operator-stats';

// A2-1165 (slice 9): per-operator drill (`/operators/:id/supplier-
// spend` + `/operators/:id/activity`) extracted to
// `./admin-operator-drill.ts`. The `OperatorSupplierSpendResponse`
// / `OperatorActivityDay` / `OperatorActivityResponse` shapes were
// inline here and moved with the functions — they have no other
// consumers, so promoting them to `@loop/shared` would just add
// indirection. Re-export keeps the per-operator drill page +
// paired tests untouched.
export {
  type OperatorSupplierSpendResponse,
  type OperatorActivityDay,
  type OperatorActivityResponse,
  getOperatorSupplierSpend,
  getOperatorActivity,
} from './admin-operator-drill';

// A2-1165 (slice 2): admin audit-tail types + read extracted to
// `./admin-audit.ts`. Re-export keeps existing consumers
// (AdminAuditTail.tsx, routes/admin.audit.tsx, both paired tests)
// untouched.
export {
  type AdminAuditTailRow,
  type AdminAuditTailResponse,
  getAdminAuditTail,
} from './admin-audit';

// A2-1165 (slice 10): per-merchant fleet stats + merchants-flywheel-
// share moved to `./admin-merchant-stats.ts` (ADR 011 / 015). The
// inline `MerchantStatsRow` / `MerchantStatsResponse` /
// `MerchantFlywheelShareRow` / `MerchantsFlywheelShareResponse`
// shapes moved with the functions — no other consumers, so
// promoting them to `@loop/shared` would just add indirection.
// Re-export keeps `MerchantStatsCard.tsx`,
// `MerchantsFlywheelShareCard.tsx`, `routes/admin.merchants.tsx`
// and their paired tests untouched.
export {
  type MerchantStatsRow,
  type MerchantStatsResponse,
  type MerchantFlywheelShareRow,
  type MerchantsFlywheelShareResponse,
  getMerchantStats,
  getAdminMerchantsFlywheelShare,
} from './admin-merchant-stats';

// A2-1165 (slice 11): stuck-orders + stuck-payouts (the two
// safety-critical alerting cards on the admin dashboard) moved to
// `./admin-stuck.ts` (ADR 011 / 013 / 015 / 016). Inline shapes
// moved with the functions — no other consumers. Re-export keeps
// `StuckOrdersCard.tsx`, `StuckPayoutsCard.tsx`, `routes/admin.
// dashboard.tsx` and their paired tests untouched.
export {
  type StuckOrderRow,
  type StuckOrdersResponse,
  type StuckPayoutRow,
  type StuckPayoutsResponse,
  getStuckOrders,
  getStuckPayouts,
} from './admin-stuck';

// A2-1165 (slice 12): orders/cashback/payouts activity time-series
// moved to `./admin-activity.ts`. Inline shapes moved with the
// functions — no other consumers. The barrel re-export at the
// payouts-activity anchor below covers all three reads + 8 type
// re-exports.

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
// A2-1165 (slice 12): cashback-activity moved to
// `./admin-activity.ts` (paired with orders/payouts activity).

// A2-1165 (slice 12): orders/cashback/payouts activity time-series
// (admin dashboard sparkline + bar charts) extracted to
// `./admin-activity.ts`. Inline shapes moved with the functions —
// no other consumers. Re-export keeps existing chart cards + paired
// tests untouched.
export {
  type OrdersActivityDay,
  type OrdersActivityResponse,
  type CashbackActivityDay,
  type CashbackActivityResponse,
  type PerCurrencyAmount,
  type PayoutsActivityDay,
  type PayoutsActivityResponse,
  type PerAssetPayoutAmount,
  getOrdersActivity,
  getCashbackActivity,
  getPayoutsActivity,
} from './admin-activity';

export async function getPayoutsByAsset(): Promise<{ rows: PayoutsByAssetRow[] }> {
  return authenticatedRequest<{ rows: PayoutsByAssetRow[] }>('/api/admin/payouts-by-asset');
}

export interface AdminPayoutView {
  id: string;
  userId: string;
  /** NULL for `kind='withdrawal'` rows (ADR-024 §2). */
  orderId: string | null;
  /** ADR-024 §2 discriminator. */
  kind: 'order_cashback' | 'withdrawal';
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

// A2-1165 (slice 16): ADR 017 admin-write envelope primitives
// (`AdminWriteAudit` + `AdminWriteEnvelope<T>`) moved to
// `./admin-write-envelope.ts`. Re-export keeps existing consumers
// (`ReasonDialog.tsx`, write-button helpers, paired tests)
// untouched, and lets future writer-slice extractions share the
// primitives without a circular import back into admin.ts.
export type { AdminWriteAudit, AdminWriteEnvelope } from './admin-write-envelope';

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

// A2-1165 (slice 19): fleet-level user-activity leaderboards
// (top-by-pending-payout + recycling-activity) moved to
// `./admin-user-fleet-activity.ts`. Inline shapes moved with
// the functions — no other consumers. Re-export keeps
// `TopUsersByPendingPayoutCard.tsx`,
// `UsersRecyclingActivityCard.tsx`, the treasury route + paired
// tests untouched.
export {
  type TopUserByPendingPayoutEntry,
  type TopUsersByPendingPayoutResponse,
  type UserRecyclingActivityRow,
  type UsersRecyclingActivityResponse,
  getTopUsersByPendingPayout,
  getAdminUsersRecyclingActivity,
} from './admin-user-fleet-activity';

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

// A2-1165 (slice 1): Discord notifier admin types + reads/writes
// extracted to `./admin-discord.ts`. Re-export keeps existing
// consumers (DiscordNotifiersCard + test) untouched.
export {
  type AdminDiscordNotifier,
  type AdminDiscordNotifiersResponse,
  type AdminDiscordChannel,
  type AdminDiscordTestResponse,
  getAdminDiscordNotifiers,
  testDiscordChannel,
} from './admin-discord';

// A2-1165 (slice 14): per-user drill surface (credits + cashback-
// summary + flywheel-stats) moved to `./admin-user-drill.ts`
// (ADR 009 / 015). Inline shapes moved with the functions — no
// other consumers. Re-export keeps the user-detail page + paired
// tests untouched.
export {
  type AdminUserCreditRow,
  type AdminUserCreditsResponse,
  type AdminUserCashbackSummary,
  type AdminUserFlywheelStats,
  getAdminUserCredits,
  getAdminUserCashbackSummary,
  getAdminUserFlywheelStats,
} from './admin-user-drill';

// A2-1165 (slice 15): per-merchant drill surface (flywheel-stats
// + cashback-summary) moved to `./admin-merchant-drill.ts`,
// sibling of the per-user drill from slice 14. Inline shapes
// moved with the functions — no other consumers. Re-export keeps
// the merchant-detail page + paired tests untouched.
export {
  type AdminMerchantFlywheelStats,
  type AdminMerchantCashbackCurrencyBucket,
  type AdminMerchantCashbackSummary,
  getAdminMerchantFlywheelStats,
  getAdminMerchantCashbackSummary,
} from './admin-merchant-drill';

// A2-1165 (slice 13): per-merchant + per-user payment-method-
// share also moved to `./admin-payment-method-share.ts`,
// consolidated with the fleet read so the rail-mix mix-axis lives
// in one file. The barrel re-export at the top covers all three.

// A2-1165 (slice 17): cashback-monthly + payouts-monthly time-
// series quartet (fleet + per-user + per-merchant cashback +
// fleet payouts) moved to `./admin-monthly.ts`. Inline shapes
// moved with the functions — no other consumers. Re-export keeps
// `MonthlyCashbackChart.tsx`, `PayoutsMonthlyChart.tsx`, and the
// user/merchant drill routes + paired tests untouched.
export {
  type AdminCashbackMonthlyEntry,
  type AdminCashbackMonthlyResponse,
  type AdminPayoutsMonthlyEntry,
  type AdminPayoutsMonthlyResponse,
  type AdminUserCashbackMonthlyEntry,
  type AdminUserCashbackMonthlyResponse,
  type AdminMerchantCashbackMonthlyEntry,
  type AdminMerchantCashbackMonthlyResponse,
  getAdminCashbackMonthly,
  getAdminPayoutsMonthly,
  getAdminUserCashbackMonthly,
  getAdminMerchantCashbackMonthly,
} from './admin-monthly';

// A2-1165 (slice 18): merchant activity drill (flywheel-activity
// time-series + top-earners ranking) moved to
// `./admin-merchant-activity.ts`. Companion to the scalar
// `admin-merchant-drill.ts` from slice 15. Inline shapes moved
// with the functions — no other consumers. Re-export keeps
// `MerchantFlywheelActivityChart.tsx`,
// `MerchantTopEarnersTable.tsx`, the merchant-drill route +
// paired tests untouched.
export {
  type MerchantFlywheelActivityDay,
  type AdminMerchantFlywheelActivityResponse,
  type MerchantTopEarnerRow,
  type AdminMerchantTopEarnersResponse,
  getAdminMerchantFlywheelActivity,
  getAdminMerchantTopEarners,
} from './admin-merchant-activity';

// A2-1165 (slice 21): payment-method-activity time-series chart
// + per-user cashback-by-merchant support-triage drill moved to
// their respective sibling modules. Both inline shapes moved
// with the functions. Re-exports keep
// `PaymentMethodActivityChart.tsx`,
// `UserCashbackByMerchantCard.tsx`, and paired tests untouched.
export {
  type PaymentMethodActivityDay,
  type AdminPaymentMethodActivityResponse,
  getAdminPaymentMethodActivity,
} from './admin-payment-method-activity';

export {
  type AdminUserCashbackByMerchantRow,
  type AdminUserCashbackByMerchantResponse,
  getAdminUserCashbackByMerchant,
} from './admin-user-cashback-by-merchant';

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
