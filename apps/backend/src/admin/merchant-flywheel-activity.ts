/**
 * Admin per-merchant flywheel-activity time-series (#641).
 *
 * `GET /api/admin/merchants/:merchantId/flywheel-activity?days=30` —
 * daily per-merchant recycled-vs-total fulfilled-order series.
 * Time-axis companion to the scalar flywheel-stats endpoint
 * (#623): that one answers "what's the total flywheel share at
 * this merchant over the last 31 days?" as a scalar; this one
 * answers "is that share rising or falling over time?" at daily
 * resolution.
 *
 * Drives a forthcoming `MerchantFlywheelActivityChart` on the
 * merchant drill-down — the line between pivot success ("LOOP
 * adoption is trending up at Amazon") and pivot stall ("LOOP
 * adoption plateaued six weeks ago on this merchant").
 *
 * Shape (one row per day in the window):
 *   { day, recycledCount, totalCount, recycledChargeMinor,
 *     totalChargeMinor }
 *
 * Both recycled and total are emitted so the client can compute
 * both rail-mix ratio (recycled/total orders) and charge-weighted
 * ratio (recycledChargeMinor/totalChargeMinor) locally — same
 * axes as the scalar endpoint and the fleet leaderboard.
 *
 * Invariants:
 *   - Window: `?days=` (default 30, max 180). Same shape as the
 *     payouts-activity and cashback-activity siblings.
 *   - `generate_series` LEFT JOIN zero-fills empty days so the
 *     chart's x-axis stays dense without client-side gap-fill.
 *   - Bucketed on `fulfilled_at::date` — the day the flywheel
 *     event actually happened, not when the order was created.
 *   - Only `state='fulfilled'`; unfulfilled orders don't count
 *     toward flywheel share until they land.
 *   - Zero-volume merchants return a zero-filled series (not 404)
 *     — a catalog merchant with no orders yet is valid.
 *   - bigint-as-string on chargeMinor totals.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-flywheel-activity' });

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

export interface MerchantFlywheelActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  recycledCount: number;
  totalCount: number;
  /** SUM(charge_minor) over loop_asset orders on this day. bigint-as-string. */
  recycledChargeMinor: string;
  /** SUM(charge_minor) over all fulfilled orders on this day. bigint-as-string. */
  totalChargeMinor: string;
}

export interface MerchantFlywheelActivityResponse {
  merchantId: string;
  days: number;
  rows: MerchantFlywheelActivityDay[];
}

interface AggRow {
  day: string | Date;
  recycled_count: string | number | bigint | null;
  total_count: string | number | bigint | null;
  recycled_charge_minor: string | number | bigint | null;
  total_charge_minor: string | number | bigint | null;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toNumber(value: string | number | bigint | null): number {
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint | null): string {
  if (value === null) return '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminMerchantFlywheelActivityHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // One row per day. `COUNT(*) FILTER` and `SUM() FILTER` roll
    // recycled vs total into the same aggregate — avoids two
    // queries or a self-join.
    const result = await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text AS day,
        COUNT(o.id) FILTER (WHERE ${orders.paymentMethod} = 'loop_asset')::bigint
          AS recycled_count,
        COUNT(o.id)::bigint AS total_count,
        COALESCE(SUM(${orders.chargeMinor})
          FILTER (WHERE ${orders.paymentMethod} = 'loop_asset'), 0)::bigint
          AS recycled_charge_minor,
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint
          AS total_charge_minor
      FROM days
      LEFT JOIN ${orders} o
        ON ${orders.merchantId} = ${merchantId}
        AND ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt}::date = days.d
      GROUP BY days.d
      ORDER BY days.d ASC
    `);

    const rawRows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: MerchantFlywheelActivityDay[] = rawRows.map((r) => ({
      day: toYmd(r.day),
      recycledCount: toNumber(r.recycled_count),
      totalCount: toNumber(r.total_count),
      recycledChargeMinor: toStringBigint(r.recycled_charge_minor),
      totalChargeMinor: toStringBigint(r.total_charge_minor),
    }));

    return c.json<MerchantFlywheelActivityResponse>({ merchantId, days, rows });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant flywheel-activity query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute merchant flywheel activity' },
      500,
    );
  }
}
