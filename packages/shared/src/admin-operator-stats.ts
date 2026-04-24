/**
 * Admin operator-level stats response shapes (A2-1506 slice).
 *
 * Two endpoints surface CTX-operator-pool performance (ADR 013):
 *
 *   - `GET /api/admin/operators?since=<iso>` — per-operator order
 *     counts (volume + success mix + recency).
 *   - `GET /api/admin/operators/latency?since=<iso>` — per-operator
 *     latency percentiles (p50/p95/p99/mean, in ms).
 *
 * Both were re-declared in backend handler + web service. Consolidated.
 */

/**
 * One row of `/api/admin/operators`. Operator health at a glance —
 * volume, success count, failure count, and when ops last saw traffic.
 */
export interface OperatorStatsRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  /** ISO-8601 UTC of the most recent order this operator handled. */
  lastOrderAt: string;
}

export interface OperatorStatsResponse {
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: OperatorStatsRow[];
}

/**
 * One row of `/api/admin/operators/latency`. Percentiles computed from
 * `orders.fulfilledAt - orders.procuringAt` over the window; values
 * are milliseconds integers. `sampleCount` is how many fulfilled
 * orders contributed (below ~20, percentiles are noisy).
 */
export interface OperatorLatencyRow {
  operatorId: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
}

export interface OperatorLatencyResponse {
  /** ISO-8601 lower bound of the window (inclusive). */
  since: string;
  rows: OperatorLatencyRow[];
}
