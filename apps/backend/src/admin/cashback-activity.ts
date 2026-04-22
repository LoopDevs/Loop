/**
 * Admin cashback-activity time-series (ADR 009 / 015).
 *
 * `GET /api/admin/cashback-activity` — daily cashback-accrual
 * aggregate for the admin dashboard's trend sparkline. Returns a
 * dense day-by-day series: every day in the window has a row,
 * even zero-activity days, so the UI's line chart doesn't have
 * gappy x-axis ticks.
 *
 * Window: `?days=` (default 30, max 180). Rows are emitted in
 * ascending day order (oldest → newest) because that's how the
 * chart renders left-to-right. Per-currency pivoting would
 * explode the payload for a daily feed; instead we emit a single
 * row per day with a nested `byCurrency` map.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-activity' });

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

export interface PerCurrencyAmount {
  currency: string;
  amountMinor: string;
}

export interface CashbackActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** Count of cashback-type credit_transactions on this day. */
  count: number;
  /** Per-currency minor-unit sums. Empty on zero-activity days. */
  byCurrency: PerCurrencyAmount[];
}

export interface CashbackActivityResponse {
  days: number;
  rows: CashbackActivityDay[];
}

interface AggRow {
  day: string | Date;
  currency: string | null;
  count: string | number;
  amount_minor: string | number | bigint;
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

export async function adminCashbackActivityHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // generate_series(today - days, today) LEFT JOIN credit_transactions
    // so every day has a row, zero or not. Per-day × per-currency
    // rows collapse to one row per (day, currency) via GROUP BY; the
    // handler pivots into { day, count, byCurrency: [...] }.
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
        ct.currency,
        COUNT(ct.id)::bigint AS count,
        COALESCE(SUM(ct.amount_minor), 0)::bigint AS amount_minor
      FROM days
      LEFT JOIN credit_transactions ct
        ON ct.type = 'cashback'
        AND ct.created_at::date = days.d
      GROUP BY days.d, ct.currency
      ORDER BY days.d ASC, ct.currency ASC NULLS LAST
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    // Pivot (day, currency) rows → { day: {...} }.
    const byDay = new Map<string, CashbackActivityDay>();
    for (const r of rows) {
      const day = toYmd(r.day);
      let entry = byDay.get(day);
      if (entry === undefined) {
        entry = { day, count: 0, byCurrency: [] };
        byDay.set(day, entry);
      }
      if (r.currency !== null) {
        entry.count += toNumber(r.count);
        entry.byCurrency.push({
          currency: r.currency,
          amountMinor: toStringBigint(r.amount_minor),
        });
      }
      // r.currency === null rows come from the LEFT-JOIN zero-day
      // case — the day entry is already seeded as count: 0 above.
    }

    const ordered = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    return c.json<CashbackActivityResponse>({ days, rows: ordered });
  } catch (err) {
    log.error({ err }, 'Admin cashback-activity query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute activity' }, 500);
  }
}
