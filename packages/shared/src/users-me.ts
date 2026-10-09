/**
 * `/api/users/me*` wire shapes (ADR 015 / ADR 016).
 *
 * A2-1505 flagged that 13 `/me*` response shapes lived only in
 * `apps/web/app/services/user.ts`. They move here because both
 * `apps/backend` and `apps/web` need the same wire contract — web
 * consumes it, backend emits it, and a second definition on either
 * side is drift waiting to happen.
 *
 * Integer columns serialise as strings (BigInt-safe). Timestamps are
 * ISO-8601.
 */
import type { HomeCurrency } from './loop-asset.js';
import type { CreditTransactionType } from './credit-transaction-type.js';
import type { StaffRole } from './admin-staff.js';
import type { CashbackDestination } from './users-account.js';

/**
 * `GET /api/users/me` / `POST /api/users/me/stable-currency` response.
 * Balances and linked wallets live on `UserAccountView`.
 */
export interface UserMeView {
  id: string;
  email: string;
  /**
   * Deprecated read-compat shim (ADR 037): true iff `staffRole` is
   * `'admin'`. New gating should key off `staffRole`.
   */
  isAdmin: boolean;
  /**
   * ADR 037 staff role resolved from the `staff_roles` collection —
   * `'admin'`, `'support'`, or `null` for regular users. The web
   * admin shell keys its role-aware nav + write-button visibility
   * off this field (falling back to `isAdmin` while the backend
   * rollout completes — see `useStaffRole`).
   */
  staffRole: StaffRole | null;
  stableCurrency: string;
  /** Where credited cashback lands at CTX: `account` pays out to the linked wallet, `savings` fills the pot. */
  cashbackDestination: CashbackDestination;
  /** Home country (ISO 3166-1 alpha-2, uppercase), mirrored from CTX's `user.country`; null until chosen. */
  country: string | null;
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
  currency: HomeCurrency | null;
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
