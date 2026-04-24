/**
 * Admin cashback-realization response shapes (A2-1506 slice).
 *
 * ADR 009 / 015 — the flywheel-health KPIs. Two endpoints:
 *
 *   - `GET /api/admin/cashback-realization` — per-currency (plus a
 *     fleet-wide `currency: null` row) lifetime earned / spent /
 *     withdrawn / outstanding. `recycledBps = spent / earned × 10000`
 *     is the headline "is cashback actually being used" metric.
 *   - `GET /api/admin/cashback-realization/daily?days=N` — daily
 *     trend of the same KPIs for the sparkline on /admin.
 *
 * The backend's `RealizationDay` / `RealizationDailyResponse` local
 * names were re-aliased to the canonical wire names used in
 * `openapi.ts` registration + the web consumer; the inconsistency
 * broke the one-name-per-wire-shape contract that A2-1506 exists
 * to enforce. Re-exported on both sides.
 */

/**
 * One row of the flat cashback-realization endpoint. `currency: null`
 * is the fleet-wide aggregate; every other row is keyed on an ISO
 * 4217 code. All amounts are bigint-string minor units.
 */
export interface CashbackRealizationRow {
  /** ISO 4217 code; `null` for the fleet-wide aggregate row. */
  currency: string | null;
  /** Lifetime cashback earned. BigInt as string, minor units. */
  earnedMinor: string;
  /** Lifetime cashback spent on new Loop orders. BigInt as string, minor units. */
  spentMinor: string;
  /** Lifetime cashback withdrawn off-ledger. BigInt as string, minor units. */
  withdrawnMinor: string;
  /** Current outstanding liability (sum of user_credits.balance_minor). */
  outstandingMinor: string;
  /** 10 000 × `recycledPct`. `spent / earned` — the flywheel headline KPI. */
  recycledBps: number;
}

export interface CashbackRealizationResponse {
  rows: CashbackRealizationRow[];
}

/**
 * One (day × currency) bucket for the daily-trend sparkline. Dense —
 * every day in the window has a row even when nothing landed — so
 * the chart keeps a stable x-axis on quiet periods.
 */
export interface CashbackRealizationDay {
  day: string;
  currency: string;
  earnedMinor: string;
  spentMinor: string;
  recycledBps: number;
}

export interface CashbackRealizationDailyResponse {
  days: number;
  rows: CashbackRealizationDay[];
}
