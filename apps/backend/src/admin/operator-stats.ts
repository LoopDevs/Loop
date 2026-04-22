/**
 * Admin operator-stats snapshot (ADR 013).
 *
 * `GET /api/admin/operator-stats` — per-operator aggregate of which
 * CTX service account actually carried which orders, in a rolling
 * window. Supplier-spend (`/api/admin/supplier-spend`) tells ops
 * *what* CTX was paid per currency; this endpoint tells them *which
 * operator account* carried the traffic, which matters when one
 * operator's breaker trips and Loop wants to know the pre-trip load
 * distribution.
 *
 * Per operator:
 *   - orderCount       — orders the operator has touched (any state)
 *   - fulfilledCount   — subset the operator closed successfully
 *   - failedCount      — subset that ended in `failed`
 *   - lastOrderAt      — most recent `createdAt` that cited this operator
 *
 * Window: `?since=<iso-8601>` (default 24h). Clamped at 366 days
 * for the same reason as supplier-spend — a full-history aggregate
 * scans the orders table with no covering index.
 *
 * Only rows with a non-null `ctxOperatorId` are aggregated — pre-
 * procurement orders (state=pending_payment/paid) have no operator
 * yet and would pollute the list with a `null` group.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operator-stats' });

export interface OperatorStatsRow {
  operatorId: string;
  orderCount: number;
  fulfilledCount: number;
  failedCount: number;
  lastOrderAt: string;
}

export interface OperatorStatsResponse {
  since: string;
  rows: OperatorStatsRow[];
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

interface AggRow {
  operator_id: string;
  order_count: string | number;
  fulfilled_count: string | number;
  failed_count: string | number;
  last_order_at: string | Date;
}

export async function adminOperatorStatsHandler(c: Context): Promise<Response> {
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
    const result = await db.execute(sql`
      SELECT
        ${orders.ctxOperatorId} AS operator_id,
        COUNT(*)::bigint AS order_count,
        SUM(CASE WHEN ${orders.state} = 'fulfilled' THEN 1 ELSE 0 END)::bigint AS fulfilled_count,
        SUM(CASE WHEN ${orders.state} = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
        MAX(${orders.createdAt}) AS last_order_at
      FROM ${orders}
      WHERE ${orders.ctxOperatorId} IS NOT NULL
        AND ${orders.createdAt} >= ${since}
      GROUP BY ${orders.ctxOperatorId}
      ORDER BY order_count DESC, operator_id ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: OperatorStatsRow[] = raw.map((r) => ({
      operatorId: r.operator_id,
      orderCount: Number(r.order_count),
      fulfilledCount: Number(r.fulfilled_count),
      failedCount: Number(r.failed_count),
      lastOrderAt:
        r.last_order_at instanceof Date
          ? r.last_order_at.toISOString()
          : new Date(r.last_order_at).toISOString(),
    }));

    const body: OperatorStatsResponse = { since: since.toISOString(), rows };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Operator-stats aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute operator stats' }, 500);
  }
}
