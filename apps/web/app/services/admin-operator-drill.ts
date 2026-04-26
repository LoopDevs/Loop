/**
 * A2-1165 (slice 9): admin operator-drill surface extracted from
 * `services/admin.ts`. Two reads scope fleet metrics down to a
 * single CTX operator (ADR 013 / 022) — the per-operator drill
 * page on top of the fleet operator-stats / operator-latency /
 * operator-mix rows that have already been split out:
 *
 * - `GET /api/admin/operators/:operatorId/supplier-spend` —
 *   per-currency wholesale-spend rows scoped to one operator.
 *   Default window 24h, server clamps `?since=` at 366d.
 * - `GET /api/admin/operators/:operatorId/activity` — per-day
 *   created / fulfilled / failed counts for one operator over
 *   `?days=1-90` (default 7). Backend zero-fills so the chart
 *   has a stable N-row layout.
 *
 * `OperatorSupplierSpendResponse` reuses `SupplierSpendRow` from
 * `@loop/shared/admin-supplier-spend.ts` rather than re-declaring
 * the columns; the per-operator response shape (`OperatorSupplier
 * SpendResponse` and `OperatorActivityDay` / `OperatorActivity
 * Response`) was inline in `services/admin.ts` and moves here
 * without going through `@loop/shared` — these shapes are
 * specific to the drill surface and have no other consumers.
 */
import type { SupplierSpendRow } from '@loop/shared';
import { authenticatedRequest } from './api-client';

/**
 * Per-operator per-currency supplier-spend response. Same row shape
 * as the fleet `SupplierSpendRow` — reused so the drill page table
 * doesn't duplicate the type.
 */
export interface OperatorSupplierSpendResponse {
  operatorId: string;
  since: string;
  rows: SupplierSpendRow[];
}

/** Per-operator per-day activity row. */
export interface OperatorActivityDay {
  day: string;
  created: number;
  fulfilled: number;
  failed: number;
}

export interface OperatorActivityResponse {
  operatorId: string;
  windowDays: number;
  days: OperatorActivityDay[];
}

/** `GET /api/admin/operators/:operatorId/supplier-spend` — server clamps `?since=` at 366d. */
export async function getOperatorSupplierSpend(
  operatorId: string,
  opts: { since?: string } = {},
): Promise<OperatorSupplierSpendResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<OperatorSupplierSpendResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/supplier-spend${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/operators/:operatorId/activity` — backend zero-fills `?days=1-90` (default 7). */
export async function getOperatorActivity(
  operatorId: string,
  opts: { days?: number } = {},
): Promise<OperatorActivityResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  const qs = params.toString();
  return authenticatedRequest<OperatorActivityResponse>(
    `/api/admin/operators/${encodeURIComponent(operatorId)}/activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
