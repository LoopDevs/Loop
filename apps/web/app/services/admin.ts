// A2-1166 / A2-1165 close-out: `services/admin.ts` is a pure
// barrel re-export module. No values defined here, no inline
// shapes, no helpers — every admin endpoint and every admin
// surface lives in its own `./admin-<surface>.ts` sibling. This
// file exists so existing consumers keep importing from
// `~/services/admin` without re-targeting; new code should
// import the surface module directly.
//
// `LoopAssetCode` and `CreditTransactionType` are re-exported
// from `@loop/shared` here for the same reason — historically
// `~/services/admin` was the import path, and renaming every
// consumer is more churn than it's worth.
export type { CreditTransactionType, LoopAssetCode } from '@loop/shared';

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

// A2-1165 (slice 27): settlement-lag read moved to
// `./admin-settlement-lag.ts`. Type definitions remain canonical
// in `@loop/shared/admin-settlement-lag.ts` (per A2-1506).
// Re-export keeps `SettlementLagCard.tsx` + paired test untouched.
export {
  type SettlementLagResponse,
  type SettlementLagRow,
  getSettlementLag,
} from './admin-settlement-lag';

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

// A2-1165 (slice 27): `downloadAdminCsv` browser-side helper
// (used by every admin CSV-export button) moved to
// `./admin-csv.ts`. Re-export keeps every CSV-button caller
// (`routes/admin.cashback.tsx`, `routes/admin.payouts.tsx`,
// `routes/admin.users.tsx`, etc.) untouched.
export { downloadAdminCsv } from './admin-csv';

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

// A2-1165 (slice 27): top-users leaderboard moved to
// `./admin-top-users.ts`. Inline shapes moved with the function
// — no other consumers. Re-export keeps `TopUsersCard.tsx` and
// paired test untouched.
export { type TopUserRow, type TopUsersResponse, getTopUsers } from './admin-top-users';

// A2-1165 (slice 26): payouts-by-asset incident-triage view
// extracted to `./admin-payouts-by-asset.ts`. Re-export below
// covers the function + 2 type re-exports.
export {
  type PerStateBreakdown,
  type PayoutsByAssetRow,
  getPayoutsByAsset,
} from './admin-payouts-by-asset';

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

// A2-1165 (slice 25): payouts surface (AdminPayoutView + listPayouts
// + getAdminPayout + getAdminPayoutByOrder + retryPayout writer)
// moved to `./admin-payouts.ts`. Inline shape moved with the
// functions. The barrel re-export at the retryPayout anchor below
// covers all 5 exports.

// A2-1165 (slice 16): ADR 017 admin-write envelope primitives
// (`AdminWriteAudit` + `AdminWriteEnvelope<T>`) moved to
// `./admin-write-envelope.ts`. Re-export keeps existing consumers
// (`ReasonDialog.tsx`, write-button helpers, paired tests)
// untouched, and lets future writer-slice extractions share the
// primitives without a circular import back into admin.ts.
export type { AdminWriteAudit, AdminWriteEnvelope } from './admin-write-envelope';

// A2-1165 (slice 25): admin payouts surface lives in
// `./admin-payouts.ts`. `retryPayout` is the third writer slice
// after #1125 (cashback-config) and #1127 (user-credits), reusing
// the same `AdminWriteEnvelope` primitives from slice 16 (#1121).
// Re-export keeps `AdminPayoutsTable.tsx`,
// `AdminPayoutDetail.tsx`, `RetryPayoutButton.tsx`,
// `routes/admin.payouts.tsx`, `routes/admin.payouts.$id.tsx`,
// paired tests untouched.
export {
  type AdminPayoutView,
  listPayouts,
  getAdminPayout,
  getAdminPayoutByOrder,
  retryPayout,
} from './admin-payouts';

// A2-1165 (slice 24): orders surface (AdminOrderState alias +
// AdminOrderView shape + getAdminOrder + listAdminOrders) moved
// to `./admin-orders.ts`. Inline shape + alias moved with the
// functions — `AdminOrderState` was the only re-export of
// `OrderState` from `@loop/shared`, kept under the `Admin…` name
// so existing consumers don't need to re-import. The barrel
// re-export at the listAdminOrders anchor below covers all 4
// exports.

// A2-1165 (slice 23): admin users directory + detail (list +
// drill-header + by-email lookup) moved to
// `./admin-users-list.ts`. Inline shapes moved with the
// functions — no other consumers. Re-export keeps
// `AdminUsersTable.tsx`, `routes/admin.users.tsx`,
// `routes/admin.users.$userId.tsx`, and paired tests untouched.
export {
  type AdminUserRow,
  type AdminUserDetail,
  listAdminUsers,
  getAdminUser,
  getAdminUserByEmail,
} from './admin-users-list';

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

// A2-1165 (slice 26): resyncMerchants writer (the 4th and final
// ADR-017 writer slice after #1125 / #1127 / #1130) moved to
// `./admin-merchants-resync.ts`. Re-export keeps
// `MerchantResyncButton.tsx` and paired tests untouched.
export { type AdminMerchantResyncResponse, resyncMerchants } from './admin-merchants-resync';

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

// A2-1165 (slice 22): user-credits management surface (credit-
// adjust write + withdrawal write + ledger read) moved to
// `./admin-user-credits.ts` (ADR 009 / 017 / 024). Both writes
// re-use the `AdminWriteEnvelope` primitives from slice 16. The
// idempotency-key generator that was duplicated inline in both
// writers is now a private helper in the slice file. Inline
// shapes moved with the functions — no other consumers.
// Re-export keeps `CreditAdjustmentForm.tsx`,
// `AdminWithdrawalForm.tsx`, `UserCreditTransactionsTable.tsx`,
// and paired tests untouched.
export {
  type CreditAdjustmentResult,
  type WithdrawalResult,
  type AdminCreditTransactionView,
  applyCreditAdjustment,
  applyAdminWithdrawal,
  listAdminUserCreditTransactions,
} from './admin-user-credits';

// Admin home-currency change (ADR 015 deferred § support-mediated
// change). Same `AdminWriteEnvelope` + step-up + idempotency-key
// discipline as the credit writes; lives in its own slice because
// it isn't a credit/refund/withdrawal.
export { type HomeCurrencySetResult, setUserHomeCurrency } from './admin-user-home-currency';

// A2-1165 (slice 24): admin orders surface lives in
// `./admin-orders.ts`. Re-export keeps `AdminOrdersTable.tsx`,
// `UserOrdersTable.tsx`, `routes/admin.orders.tsx`, paired
// tests untouched.
export {
  type AdminOrderState,
  type AdminOrderView,
  getAdminOrder,
  listAdminOrders,
} from './admin-orders';

// A2-1165 (slice 26): merchant-flows lifetime cashback table
// moved to `./admin-merchant-flows.ts`. Re-export keeps
// `routes/admin.cashback.tsx` and paired tests untouched.
export { type MerchantFlow, listMerchantFlows } from './admin-merchant-flows';
