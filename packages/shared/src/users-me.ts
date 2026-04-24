/**
 * `/api/users/me*` wire shapes (ADR 015 / ADR 016).
 *
 * A2-1505 flagged that 13 `/me*` response shapes lived only in
 * `apps/web/app/services/user.ts`. They move here because both
 * `apps/backend` and `apps/web` need the same wire contract — web
 * consumes it, backend emits it, and a second definition on either
 * side is drift waiting to happen. Examples the move catches:
 *
 *  - `UserMeView.homeCurrency` was `string` on the backend and
 *    `'USD' | 'GBP' | 'EUR'` on the web. Here it's `HomeCurrency`.
 *  - The `loop_asset` recycling path could land with typed `string`
 *    payment-method fields; here they key off `OrderPaymentMethod`.
 *
 * Integer columns serialise as strings (BigInt-safe). Timestamps are
 * ISO-8601.
 */
import type { HomeCurrency, LoopAssetCode } from './loop-asset.js';
import type { OrderPaymentMethod, OrderState } from './order-state.js';
import type { CreditTransactionType } from './credit-transaction-type.js';

/**
 * `GET /api/users/me` / `POST /api/users/me/home-currency` /
 * `PUT /api/users/me/stellar-address` response.
 *
 * `homeCurrencyBalanceMinor` is the off-chain cashback balance in
 * the current home currency's minor units, returned as a bigint-string
 * (`"0"` when the user has no ledger row yet).
 */
export interface UserMeView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: HomeCurrency;
  stellarAddress: string | null;
  homeCurrencyBalanceMinor: string;
}

/** One row of the credit-ledger history (ADR 009 / 015). */
export interface CashbackHistoryEntry {
  id: string;
  type: CreditTransactionType;
  amountMinor: string;
  currency: string;
  /** Ledger-source tag (`'order'` etc.); null when support-adjusted. */
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/** `GET /api/users/me/cashback-history` */
export interface CashbackHistoryResponse {
  entries: CashbackHistoryEntry[];
}

/** Caller-scoped on-chain payout lifecycle (ADR 015 / 016). */
export type UserPendingPayoutState = 'pending' | 'submitted' | 'confirmed' | 'failed';

/** One row of the caller's pending-payout backlog. */
export interface UserPendingPayoutView {
  id: string;
  orderId: string;
  assetCode: LoopAssetCode;
  assetIssuer: string;
  /** Stroops (7 decimals); bigint-as-string. */
  amountStroops: string;
  state: UserPendingPayoutState;
  /** Null until the payout confirms on Stellar. */
  txHash: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
}

/** `GET /api/users/me/pending-payouts` */
export interface UserPendingPayoutsResponse {
  payouts: UserPendingPayoutView[];
}

/**
 * One row of the caller's pending-payouts summary — grouped by
 * `(assetCode, state)`. Confirmed / failed states are omitted server-
 * side so this only carries in-flight work.
 */
export interface UserPendingPayoutsSummaryRow {
  assetCode: LoopAssetCode;
  state: 'pending' | 'submitted';
  count: number;
  /** Sum of amountStroops in this bucket. bigint-as-string. */
  totalStroops: string;
  /** ISO-8601 of the oldest row in the bucket. */
  oldestCreatedAt: string;
}

/** `GET /api/users/me/pending-payouts/summary` */
export interface UserPendingPayoutsSummaryResponse {
  rows: UserPendingPayoutsSummaryRow[];
}

/**
 * Caller's LOOP-asset trustline status (ADR 015). One row per
 * configured LOOP asset; `present: true` means the user's linked
 * address already has the trustline so the next payout in that asset
 * will land. `accountLinked: false` means no wallet on file.
 * `accountExists: false` means the address is linked but unfunded
 * on Stellar (needs an XLM reserve before any trustline can be
 * created).
 */
export interface StellarTrustlineRow {
  code: LoopAssetCode;
  issuer: string;
  present: boolean;
  /** bigint-as-string. `"0"` when absent. */
  balanceStroops: string;
  /** bigint-as-string. `"0"` when absent. */
  limitStroops: string;
}

/** `GET /api/users/me/stellar-trustlines` */
export interface StellarTrustlinesResponse {
  address: string | null;
  accountLinked: boolean;
  accountExists: boolean;
  rows: StellarTrustlineRow[];
}

/**
 * One row of the caller's off-chain credit balance (ADR 009 / 015).
 * Most users only ever have a row in their home currency; multi-
 * currency rows appear when an admin adjustment landed in a non-home
 * currency or the user flipped their home currency with a non-zero
 * old-bucket balance.
 */
export interface UserCreditRow {
  currency: string;
  balanceMinor: string;
  updatedAt: string;
}

/** `GET /api/users/me/credits` */
export interface UserCreditsResponse {
  credits: UserCreditRow[];
}

/**
 * Compact cashback summary — all-time + this-month totals in the
 * caller's home currency. Both totals are `type='cashback'` rows only.
 */
export interface UserCashbackSummary {
  currency: HomeCurrency;
  lifetimeMinor: string;
  thisMonthMinor: string;
}

/** One merchant × cashback row (ADR 009 / 015). */
export interface CashbackByMerchantRow {
  merchantId: string;
  cashbackMinor: string;
  orderCount: number;
  lastEarnedAt: string;
}

/** `GET /api/users/me/cashback-by-merchant` */
export interface CashbackByMerchantResponse {
  currency: HomeCurrency;
  since: string;
  rows: CashbackByMerchantRow[];
}

/** One month × currency aggregate. */
export interface CashbackMonthlyEntry {
  /** `"YYYY-MM"` in UTC. */
  month: string;
  currency: HomeCurrency;
  cashbackMinor: string;
}

/** `GET /api/users/me/cashback-monthly` */
export interface CashbackMonthlyResponse {
  entries: CashbackMonthlyEntry[];
}

/** `GET /api/users/me/orders/summary` */
export interface UserOrdersSummary {
  currency: HomeCurrency;
  totalOrders: number;
  fulfilledCount: number;
  /** `pending_payment` + `paid` + `procuring` — in-flight states. */
  pendingCount: number;
  /** `failed` + `expired` — didn't succeed. */
  failedCount: number;
  /** SUM(charge_minor) over `state='fulfilled'` only. bigint-as-string. */
  totalSpentMinor: string;
}

/**
 * Personal flywheel scalar. How many of the caller's fulfilled
 * orders were paid with a LOOP asset (recycled cashback), against the
 * total-fulfilled denominator in the same home currency.
 */
export interface UserFlywheelStats {
  currency: HomeCurrency;
  recycledOrderCount: number;
  /** SUM(charge_minor) over `loop_asset` orders. bigint-as-string. */
  recycledChargeMinor: string;
  totalFulfilledCount: number;
  /** SUM(charge_minor) over every fulfilled order in `home_currency`. */
  totalFulfilledChargeMinor: string;
}

/** One bucket of the caller's rail mix (orders × method). */
export interface UserPaymentMethodBucket {
  orderCount: number;
  /** SUM(charge_minor) for this (state, method) bucket. bigint-as-string. */
  chargeMinor: string;
}

/** `GET /api/users/me/payment-method-share` */
export interface UserPaymentMethodShareResponse {
  currency: HomeCurrency;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<OrderPaymentMethod, UserPaymentMethodBucket>;
}
