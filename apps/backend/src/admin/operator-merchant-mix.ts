/**
 * Admin per-operator merchant mix (ADR 013 / 022).
 *
 * `GET /api/admin/operators/:operatorId/merchant-mix?since=<iso>` —
 * for one operator, aggregate orders by `merchant_id`. Dual of
 * `/api/admin/merchants/:merchantId/operator-mix` (#689):
 *
 *   - /merchants/:id/operator-mix  — "which operators carry THIS merchant?"
 *   - /operators/:id/merchant-mix  — "which merchants does THIS operator carry?"
 *
 * Together they close the operator × merchant axis in both
 * directions. The /operators side is what a CTX relationship
 * owner opens during a capacity review: "op-alpha-01 is pulling
 * 40% of its volume from Starbucks — is that concentrated enough
 * to trigger an SLA discussion about that merchant specifically?"
 *
 * Per merchant returned:
 *   - merchantId      — the brand identifier
 *   - orderCount      — orders for this merchant carried by op
 *   - fulfilledCount  — subset closed successfully
 *   - failedCount     — subset ended in `failed`
 *   - lastOrderAt     — newest `createdAt` attributed to this pair
 *
 * Only rows with a non-null `ctxOperatorId` are aggregated — pre-
 * procurement orders get no operator attribution. Merchants with
 * zero orders for this operator in the window do not appear in the
 * result (this is a per-operator breakdown, not a fleet catalog).
 *
 * Window `?since=<iso-8601>` defaults to 24h, clamped at 366d.
 * Operator ID validated against a conservative slug pattern so
 * the drill URL can't smuggle SQL through the param. Zero-mix
 * operators return 200 with `rows: []`.
 */
import type { Context } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-operator-merchant-mix' });

const OPERATOR_ID_RE = /^[A-Za-z0-9._-]+$/;
const OPERATOR_ID_MAX = 128;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

// A2-1506: moved to `@loop/shared/admin-operator-mixes.ts`.
import type { OperatorMerchantMixResponse, OperatorMerchantMixRow } from '@loop/shared';
export type { OperatorMerchantMixResponse, OperatorMerchantMixRow };

interface AggRow extends Record<string, unknown> {
  merchant_id: string;
  order_count: string | number | bigint;
  fulfilled_count: string | number | bigint;
  failed_count: string | number | bigint;
  last_order_at: string | Date;
}

function toNumber(v: string | number | bigint): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function adminOperatorMerchantMixHandler(c: Context): Promise<Response> {
  const operatorId = c.req.param('operatorId');
  if (operatorId === undefined || operatorId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is required' }, 400);
  }
  if (operatorId.length > OPERATOR_ID_MAX || !OPERATOR_ID_RE.test(operatorId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'operatorId is malformed' }, 400);
  }

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
        ${orders.merchantId} AS merchant_id,
        COUNT(*)::bigint AS order_count,
        SUM(CASE WHEN ${orders.state} = 'fulfilled' THEN 1 ELSE 0 END)::bigint AS fulfilled_count,
        SUM(CASE WHEN ${orders.state} = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
        MAX(${orders.createdAt}) AS last_order_at
      FROM ${orders}
      WHERE ${and(eq(orders.ctxOperatorId, operatorId), gte(orders.createdAt, since))}
      GROUP BY ${orders.merchantId}
      ORDER BY order_count DESC, merchant_id ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: OperatorMerchantMixRow[] = raw.map((r) => ({
      merchantId: r.merchant_id,
      orderCount: toNumber(r.order_count),
      fulfilledCount: toNumber(r.fulfilled_count),
      failedCount: toNumber(r.failed_count),
      lastOrderAt:
        r.last_order_at instanceof Date
          ? r.last_order_at.toISOString()
          : new Date(r.last_order_at).toISOString(),
    }));

    const body: OperatorMerchantMixResponse = {
      operatorId,
      since: since.toISOString(),
      rows,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, operatorId }, 'Operator merchant-mix aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute merchant mix' }, 500);
  }
}
