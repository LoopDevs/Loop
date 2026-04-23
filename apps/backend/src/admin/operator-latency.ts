/**
 * Admin operator latency leaderboard (ADR 013 / 022).
 *
 * `GET /api/admin/operators/latency` — per-operator p50/p95/p99
 * fulfilment latency (ms) measured as `fulfilledAt - paidAt` for
 * fulfilled orders in the window. Operator-stats tells ops *which*
 * operators are busy; this tells them *which are slow*. Together
 * they form the operator-health dashboard: a busy operator with
 * rising p95 is the early signal before the circuit breaker trips.
 *
 * Window: `?since=<iso-8601>` (default 24h, cap 366d). Clamped
 * for the same reason as supplier-spend — a full-history scan of
 * the orders table has no covering index on `fulfilled_at`.
 *
 * Only fulfilled rows with both `paidAt` and `fulfilledAt` set and
 * a non-null `ctxOperatorId` are aggregated — mid-flight orders
 * would pollute the percentiles with spurious "already taken >1h"
 * readings.
 *
 * Sample-count is returned alongside each row so ops can down-weight
 * operators with a single order in the window (p95 of n=1 is noise).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operator-latency' });

export interface OperatorLatencyRow {
  operatorId: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
}

export interface OperatorLatencyResponse {
  since: string;
  rows: OperatorLatencyRow[];
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

interface AggRow extends Record<string, unknown> {
  operator_id: string;
  sample_count: string | number | bigint;
  p50_ms: string | number | null;
  p95_ms: string | number | null;
  p99_ms: string | number | null;
  mean_ms: string | number | null;
}

function toMs(v: string | number | null): number {
  if (v === null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export async function adminOperatorLatencyHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }

  const windowMs = Date.now() - since.getTime();
  if (windowMs > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.ctxOperatorId} AS operator_id,
        COUNT(*)::bigint AS sample_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.paidAt})) * 1000
        ) AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.paidAt})) * 1000
        ) AS p95_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.paidAt})) * 1000
        ) AS p99_ms,
        AVG(EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.paidAt})) * 1000) AS mean_ms
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.ctxOperatorId} IS NOT NULL
        AND ${orders.paidAt} IS NOT NULL
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since}
      GROUP BY ${orders.ctxOperatorId}
      ORDER BY p95_ms DESC NULLS LAST, operator_id ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: OperatorLatencyRow[] = raw.map((r) => ({
      operatorId: r.operator_id,
      sampleCount: Number(r.sample_count),
      p50Ms: toMs(r.p50_ms),
      p95Ms: toMs(r.p95_ms),
      p99Ms: toMs(r.p99_ms),
      meanMs: toMs(r.mean_ms),
    }));

    const body: OperatorLatencyResponse = { since: since.toISOString(), rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Operator-latency aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute operator latency' }, 500);
  }
}
