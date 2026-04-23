/**
 * Admin supplier-margin daily trend (ADR 011 / 013 / 015 / 024).
 *
 * `GET /api/admin/supplier-margin/daily?days=N` — time-series
 * companion to the single-point supplier-margin endpoint (#738).
 * Answers "is Loop's retained margin trending up or down?" so ops
 * spots a commercial regression (merchant config drift, supplier
 * cost changes) before the lifetime point card moves.
 *
 * Dense output via `generate_series` LEFT JOIN over fulfilled
 * orders so sparklines don't compress on gap days. LEFT-JOIN
 * null-currency rows are dropped post-query.
 *
 * Per-(day, currency) fields:
 *   - chargeMinor       (bigint-as-string)
 *   - wholesaleMinor
 *   - userCashbackMinor
 *   - loopMarginMinor
 *   - orderCount
 *   - marginBps  = loopMargin / charge × 10 000
 *
 * Window: `?days=30` default, 1..180 clamp. Matches the other
 * admin sparkline endpoints so a shared chart component renders
 * either series.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { marginBps } from './supplier-margin.js';

const log = logger.child({ handler: 'admin-supplier-margin-daily' });

export interface SupplierMarginDay {
  day: string;
  currency: string;
  chargeMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  orderCount: number;
  marginBps: number;
}

export interface SupplierMarginDailyResponse {
  days: number;
  rows: SupplierMarginDay[];
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

interface AggRow extends Record<string, unknown> {
  day: string | Date;
  currency: string | null;
  charge: string | null;
  wholesale: string | null;
  user_cashback: string | null;
  loop_margin: string | null;
  order_count: string | number | bigint | null;
}

function toYmd(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

function toBigIntSafe(v: string | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export async function adminSupplierMarginDailyHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? String(DEFAULT_DAYS), 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    const result = await db.execute<AggRow>(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text AS day,
        o.charge_currency AS currency,
        COALESCE(SUM(o.charge_minor), 0)::text AS charge,
        COALESCE(SUM(o.wholesale_minor), 0)::text AS wholesale,
        COALESCE(SUM(o.user_cashback_minor), 0)::text AS user_cashback,
        COALESCE(SUM(o.loop_margin_minor), 0)::text AS loop_margin,
        COUNT(o.id)::bigint AS order_count
      FROM days
      LEFT JOIN orders o
        ON o.state = 'fulfilled'
        AND o.fulfilled_at::date = days.d
      GROUP BY days.d, o.charge_currency
      ORDER BY days.d ASC, currency ASC NULLS LAST
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: SupplierMarginDay[] = [];
    for (const r of raw) {
      if (r.currency === null) continue; // zero-day LEFT JOIN row
      const charge = toBigIntSafe(r.charge);
      const loopMargin = toBigIntSafe(r.loop_margin);
      rows.push({
        day: toYmd(r.day),
        currency: r.currency,
        chargeMinor: charge.toString(),
        wholesaleMinor: toBigIntSafe(r.wholesale).toString(),
        userCashbackMinor: toBigIntSafe(r.user_cashback).toString(),
        loopMarginMinor: loopMargin.toString(),
        orderCount:
          typeof r.order_count === 'bigint' ? Number(r.order_count) : Number(r.order_count ?? 0),
        marginBps: marginBps(charge, loopMargin),
      });
    }

    return c.json<SupplierMarginDailyResponse>({ days, rows });
  } catch (err) {
    log.error({ err }, 'Supplier-margin daily aggregation failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute supplier-margin trend' },
      500,
    );
  }
}
