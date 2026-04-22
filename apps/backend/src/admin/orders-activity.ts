/**
 * Admin orders-activity time-series (ADR 011 / 015).
 *
 * `GET /api/admin/orders-activity` — dense day-by-day counts of
 * fulfilled orders for the admin dashboard's orders sparkline.
 * Companion to `/api/admin/cashback-activity` (#476) which is
 * keyed on credit_transactions; this one keys on orders so the
 * two trend lines can be read side-by-side (did cashback track
 * order volume?).
 *
 * Dense output: every day in the window has a row, including
 * zero-activity days (`count: 0, faceValueMinor: "0", ...`),
 * so the chart renders without gappy x-axis ticks. Default 30
 * days, clamped 1..180.
 *
 * Sums face_value_minor / wholesale_minor / user_cashback_minor /
 * loop_margin_minor alongside the count so the UI can stack the
 * sparkline into a margin-vs-cashback comparison without a second
 * endpoint.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-orders-activity' });

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

export interface OrdersActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  count: number;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

export interface OrdersActivityResponse {
  days: number;
  rows: OrdersActivityDay[];
}

interface AggRow {
  day: string | Date;
  count: string | number;
  face_value_minor: string | number | bigint;
  wholesale_minor: string | number | bigint;
  user_cashback_minor: string | number | bigint;
  loop_margin_minor: string | number | bigint;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}
function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  return Number.parseInt(value, 10);
}
function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminOrdersActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // generate_series(today - days, today) LEFT JOIN orders so every
    // day has a row. Only state='fulfilled' counts — pending/paid/
    // failed/expired aren't business value yet.
    const result = await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text                                             AS day,
        COUNT(o.id)::bigint                                      AS count,
        COALESCE(SUM(o.face_value_minor), 0)::bigint             AS face_value_minor,
        COALESCE(SUM(o.wholesale_minor), 0)::bigint              AS wholesale_minor,
        COALESCE(SUM(o.user_cashback_minor), 0)::bigint          AS user_cashback_minor,
        COALESCE(SUM(o.loop_margin_minor), 0)::bigint            AS loop_margin_minor
      FROM days
      LEFT JOIN orders o
        ON o.state = 'fulfilled'
        AND o.fulfilled_at IS NOT NULL
        AND o.fulfilled_at::date = days.d
      GROUP BY days.d
      ORDER BY days.d ASC
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const body: OrdersActivityResponse = {
      days,
      rows: rows.map((r) => ({
        day: toYmd(r.day),
        count: toNumber(r.count),
        faceValueMinor: toStringBigint(r.face_value_minor),
        wholesaleMinor: toStringBigint(r.wholesale_minor),
        userCashbackMinor: toStringBigint(r.user_cashback_minor),
        loopMarginMinor: toStringBigint(r.loop_margin_minor),
      })),
    };
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Admin orders-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute activity' }, 500);
  }
}
