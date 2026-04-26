/**
 * A2-1165 (slice 12): admin activity time-series surface extracted
 * from `services/admin.ts`. Three reads back the dashboard
 * sparkline / bar-chart cards (ADR 009 / 015 / 016):
 *
 * - `GET /api/admin/orders/activity?days=N` — per-day created /
 *   fulfilled orders. Default 7 days, server clamps [1, 90].
 * - `GET /api/admin/cashback-activity?days=N` — per-day cashback-
 *   type `credit_transactions` accrual, keyed `(day, currency)`.
 *   Default 30 days, server clamps [1, 180].
 * - `GET /api/admin/payouts-activity?days=N` — per-day confirmed-
 *   payout settlement, keyed `(day, asset_code)`. Default 30
 *   days, server clamps [1, 180]. Settlement-side sibling of
 *   cashback-activity.
 *
 * All three return oldest-first row arrays; backends emit empty
 * `byCurrency` / `byAsset` on zero-activity days so the UI can
 * render gaps without an extra `count`-branch.
 *
 * The `OrdersActivityDay` / `OrdersActivityResponse` /
 * `CashbackActivityDay` / `CashbackActivityResponse` /
 * `PayoutsActivityDay` / `PayoutsActivityResponse` /
 * `PerCurrencyAmount` / `PerAssetPayoutAmount` shapes were inline
 * in `services/admin.ts` and move with the functions. They have
 * no other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (admin dashboard chart cards
 * + paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

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
 * One day of confirmed-payout activity. Settlement-side sibling of
 * `CashbackActivityDay`. `byAsset` is empty on zero days so the UI
 * can render gaps without an extra count branch.
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

/** `GET /api/admin/orders/activity?days=N` — server clamps [1, 90], default 7. */
export async function getOrdersActivity(days?: number): Promise<OrdersActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<OrdersActivityResponse>(`/api/admin/orders/activity${qs}`);
}

/** `GET /api/admin/cashback-activity?days=N` — server clamps [1, 180], default 30. */
export async function getCashbackActivity(days?: number): Promise<CashbackActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<CashbackActivityResponse>(`/api/admin/cashback-activity${qs}`);
}

/** `GET /api/admin/payouts-activity?days=N` — server clamps [1, 180], default 30. */
export async function getPayoutsActivity(days?: number): Promise<PayoutsActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<PayoutsActivityResponse>(`/api/admin/payouts-activity${qs}`);
}
