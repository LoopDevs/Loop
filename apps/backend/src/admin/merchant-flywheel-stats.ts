/**
 * Admin per-merchant flywheel stats (ADR 011 / 015).
 *
 * `GET /api/admin/merchants/:merchantId/flywheel-stats` — scalar
 * "how much of this merchant's fulfilled volume was recycled
 * cashback?" over a 31-day window.
 *
 * Distinct from `/api/admin/merchants/flywheel-share` which is the
 * leaderboard ranked across every merchant; this one is the single-
 * merchant drill-down surface used by the `/admin/merchants/:id`
 * page. Same aggregate math, narrower scope.
 *
 * Shape:
 *   {
 *     merchantId,
 *     since,
 *     totalFulfilledCount,
 *     recycledOrderCount,
 *     recycledChargeMinor,
 *     totalChargeMinor,
 *   }
 *
 * bigint-as-string on the wire for charge totals (per-merchant
 * volumes don't realistically exceed 2^53 but we stay consistent
 * with every other cashback-adjacent endpoint).
 *
 * Merchants with zero fulfilled orders return a zeroed response
 * rather than 404 — a catalog merchant with no volume yet is a
 * valid row, just an empty one.
 */
import type { Context } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-flywheel-stats' });

const WINDOW_DAYS = 31;

export interface AdminMerchantFlywheelStats {
  merchantId: string;
  /** ISO-8601 — start of the rolling window. */
  since: string;
  totalFulfilledCount: number;
  recycledOrderCount: number;
  /** SUM(charge_minor) over recycled orders. bigint-as-string. */
  recycledChargeMinor: string;
  /** SUM(charge_minor) over every fulfilled order. bigint-as-string. */
  totalChargeMinor: string;
}

interface AggRow extends Record<string, unknown> {
  totalFulfilledCount: string | number;
  recycledOrderCount: string | number;
  recycledChargeMinor: string | number | bigint;
  totalChargeMinor: string | number | bigint;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminMerchantFlywheelStatsHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  // Mirror the shape check used on the admin list endpoint — allow
  // common catalog-id chars, cap at 128.
  if (merchantId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        COUNT(*)::int                                          AS "totalFulfilledCount",
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
        )::int                                                 AS "recycledOrderCount",
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.paymentMethod} = 'loop_asset'
          ),
          0
        )::bigint                                              AS "recycledChargeMinor",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint        AS "totalChargeMinor"
      FROM ${orders}
      WHERE ${and(
        eq(orders.merchantId, merchantId),
        eq(orders.state, 'fulfilled'),
        gte(orders.fulfilledAt, since),
      )}
    `);
    const rows: AggRow[] = Array.isArray(result)
      ? (result as AggRow[])
      : ((result as { rows?: AggRow[] }).rows ?? []);
    const row = rows[0];

    return c.json<AdminMerchantFlywheelStats>({
      merchantId,
      since: since.toISOString(),
      totalFulfilledCount: toNumber(row?.totalFulfilledCount ?? 0),
      recycledOrderCount: toNumber(row?.recycledOrderCount ?? 0),
      recycledChargeMinor: toStringBigint(row?.recycledChargeMinor ?? 0),
      totalChargeMinor: toStringBigint(row?.totalChargeMinor ?? 0),
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant-flywheel-stats query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to load merchant flywheel stats' },
      500,
    );
  }
}
