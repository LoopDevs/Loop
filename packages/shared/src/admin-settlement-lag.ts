/**
 * Admin settlement-lag response shape (A2-1506 final slice).
 *
 * `GET /api/admin/payouts/settlement-lag?since=<iso>` — per-LOOP-asset
 * (plus fleet-wide aggregate row with `assetCode: null`) latency
 * percentiles for off-chain → on-chain cashback settlement (ADR 015).
 * Measured as `pendingPayouts.confirmedAt - pendingPayouts.createdAt`.
 * `sampleCount` lets the UI down-weight low-n rows (p95 of n=1 is
 * noise).
 */
export interface SettlementLagRow {
  /** LOOP asset code; `null` for the fleet-wide aggregate row. */
  assetCode: string | null;
  sampleCount: number;
  p50Seconds: number;
  p95Seconds: number;
  maxSeconds: number;
  meanSeconds: number;
}

export interface SettlementLagResponse {
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: SettlementLagRow[];
}
