/**
 * A2-1165 (slice 8): admin operator-stats + operator-latency
 * surface extracted from `services/admin.ts`. Two reads cover the
 * fleet view of CTX operators (ADR 013):
 *
 * - `GET /api/admin/operator-stats` — per-operator order-count /
 *   success-count / failure-count keyed on `orders.ctxOperatorId`.
 *   Rows where the operator is still null (pre-procurement) are
 *   skipped server-side.
 * - `GET /api/admin/operators/latency` — fleet per-operator
 *   p50/p95/p99 of `fulfilledAt - paidAt`. Percentiles are
 *   reported in ms.
 *
 * Both default to a 24h window and accept `?since=<iso>` (server
 * clamps to 366d). Type definitions live canonically in
 * `@loop/shared/admin-operator-stats.ts` (per A2-1506); this file
 * re-exports them alongside the two functions. `services/admin.ts`
 * keeps the barrel so existing consumers
 * (`OperatorStatsCard.tsx`, `OperatorLatencyCard.tsx`,
 * `routes/admin.operators.tsx` + paired tests) don't have to
 * re-target imports.
 */
import type {
  OperatorLatencyResponse,
  OperatorLatencyRow,
  OperatorStatsResponse,
  OperatorStatsRow,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  OperatorStatsResponse,
  OperatorStatsRow,
  OperatorLatencyResponse,
  OperatorLatencyRow,
};

/** `GET /api/admin/operator-stats` — server clamps `?since=` to 366d. */
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

/** `GET /api/admin/operators/latency` — server clamps `?since=` to 366d. */
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
