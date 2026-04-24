/**
 * Admin per-merchant operator mix (ADR 013 / 022).
 *
 * `GET /api/admin/merchants/:merchantId/operator-mix?since=<iso>` —
 * for one merchant, aggregate orders by `ctxOperatorId`. Exposes
 * the merchant × operator axis currently not surfaced elsewhere:
 *
 *   - /operator-stats           fleet-wide per-operator (any merchant)
 *   - /merchant-stats           fleet-wide per-merchant (any operator)
 *   - /merchants/:id/operator-mix  per-merchant × per-operator (this file)
 *
 * Answers the triage question ops asks during incidents:
 *   "merchant X is slow / failing right now — which operator
 *    is primarily carrying them?"
 *
 * Per operator returned:
 *   - orderCount      — orders for this merchant carried by op
 *   - fulfilledCount  — subset closed successfully
 *   - failedCount     — subset ended in `failed`
 *   - lastOrderAt     — newest `createdAt` attributed to this pair
 *
 * Only rows with a non-null `ctxOperatorId` are aggregated (pre-
 * procurement orders get no operator attribution).
 *
 * Window `?since=<iso-8601>` defaults to 24h, clamped at 366d.
 * Merchant ID validated against a conservative slug pattern so
 * the drill URL can't smuggle SQL through the param. Zero-mix
 * merchants return 200 with `rows: []` — "hasn't been picked up"
 * is a valid state, not a 404.
 */
import type { Context } from 'hono';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-operator-mix' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

// A2-1506: moved to `@loop/shared/admin-operator-mixes.ts`. Re-exported
// for in-file handler builders.
import type { MerchantOperatorMixResponse, MerchantOperatorMixRow } from '@loop/shared';
export type { MerchantOperatorMixResponse, MerchantOperatorMixRow };

interface AggRow extends Record<string, unknown> {
  operator_id: string;
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

export async function adminMerchantOperatorMixHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
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
        ${orders.ctxOperatorId} AS operator_id,
        COUNT(*)::bigint AS order_count,
        SUM(CASE WHEN ${orders.state} = 'fulfilled' THEN 1 ELSE 0 END)::bigint AS fulfilled_count,
        SUM(CASE WHEN ${orders.state} = 'failed' THEN 1 ELSE 0 END)::bigint AS failed_count,
        MAX(${orders.createdAt}) AS last_order_at
      FROM ${orders}
      WHERE ${and(
        eq(orders.merchantId, merchantId),
        isNotNull(orders.ctxOperatorId),
        gte(orders.createdAt, since),
      )}
      GROUP BY ${orders.ctxOperatorId}
      ORDER BY order_count DESC, operator_id ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: MerchantOperatorMixRow[] = raw.map((r) => ({
      operatorId: r.operator_id,
      orderCount: toNumber(r.order_count),
      fulfilledCount: toNumber(r.fulfilled_count),
      failedCount: toNumber(r.failed_count),
      lastOrderAt:
        r.last_order_at instanceof Date
          ? r.last_order_at.toISOString()
          : new Date(r.last_order_at).toISOString(),
    }));

    const body: MerchantOperatorMixResponse = {
      merchantId,
      since: since.toISOString(),
      rows,
    };
    return c.json(body);
  } catch (err) {
    log.error({ err, merchantId }, 'Merchant operator-mix aggregate failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute operator mix' }, 500);
  }
}
