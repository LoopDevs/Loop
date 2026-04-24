/**
 * Admin supplier-spend response shapes (A2-1506 slice).
 *
 * ADR 013 / 015 surface the CTX-as-supplier economics on the admin
 * panel via two endpoints:
 *
 *   - `GET /api/admin/supplier-spend?since=<iso>` — fleet-wide totals
 *     grouped by (charge-currency), over a window.
 *   - `GET /api/admin/supplier-spend/activity?days=<n>&currency=<iso>` —
 *     same totals bucketed by UTC day, for the spend-activity chart.
 *
 * Both shapes lived in backend handlers (`admin/supplier-spend.ts`,
 * `admin/supplier-spend-activity.ts`) and were re-declared on the web
 * side in `services/admin.ts`. Consolidated here.
 */
import type { HomeCurrency } from './loop-asset.js';

/**
 * One (charge-currency) bucket of fulfilled-order economics in a
 * window. `marginBps` is Loop's take, clamped [0, 10000]. All amounts
 * are bigint-string minor units in the row's currency.
 */
export interface SupplierSpendRow {
  currency: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  /**
   * Loop margin as basis points of face value (loopMargin / face ×
   * 10 000). Integer, clamped [0, 10 000]. 0 when a row has zero
   * face value (shouldn't happen given the CHECK constraints, but
   * division-by-zero defence is cheap).
   */
  marginBps: number;
}

/**
 * Full response shape for `GET /api/admin/supplier-spend`.
 * `since` is the ISO-8601 inclusive lower bound applied server-side
 * (clamped to the MAX_WINDOW_MS ceiling).
 */
export interface SupplierSpendResponse {
  since: string;
  rows: SupplierSpendRow[];
}

/**
 * One (day × currency) bucket for the spend-activity chart. `day` is
 * YYYY-MM-DD in UTC. All amounts are bigint-string minor units in
 * the bucket's currency.
 */
export interface SupplierSpendActivityDay {
  day: string;
  currency: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

/**
 * `GET /api/admin/supplier-spend/activity` — daily-bucket variant of
 * `SupplierSpendRow` for time-series rendering. `currency` is the
 * single-currency filter applied server-side, or `null` when the
 * caller didn't pin one.
 */
export interface SupplierSpendActivityResponse {
  windowDays: number;
  currency: HomeCurrency | null;
  days: SupplierSpendActivityDay[];
}
