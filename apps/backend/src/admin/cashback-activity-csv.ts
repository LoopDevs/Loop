/**
 * Admin cashback-activity CSV export (ADR 009 / 015 / 018).
 *
 * `GET /api/admin/cashback-activity.csv` — daily × per-currency
 * cashback accrual as RFC 4180 CSV. Finance runs this month-end
 * to reconcile accrued cashback liability against what landed
 * in `credit_transactions`. The JSON endpoint at
 * `/api/admin/cashback-activity` pivots the same rows into a
 * `byCurrency` array per day for the dashboard sparkline; the
 * CSV keeps them flat for spreadsheet consumption.
 *
 * Shape (one row per (day, currency)):
 *   day,currency,cashback_count,cashback_minor
 *
 * Zero-activity days emit a single row with empty `currency`,
 * `0,0` — so the output is dense across the window and downstream
 * tools can render the series without gap-filling client-side.
 *
 * Window: `?days=<N>` (default 31, cap 366 per ADR 018). Row cap
 * 10 000. `amount_minor` is bigint-as-string in the caller's
 * currency (no cross-currency coercion).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-activity-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = ['day', 'currency', 'cashback_count', 'cashback_minor'] as const;

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  day: string | Date;
  currency: string | null;
  count: string | number | bigint;
  amount_minor: string | number | bigint;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toNumericString(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminCashbackActivityCsvHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // Same aggregate shape as /admin/cashback-activity (JSON) —
    // generate_series + LEFT JOIN so zero-activity days appear.
    // Ordering is day ASC then currency ASC so the CSV reads as
    // a natural month-grouped ledger.
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
      LIMIT ${ROW_CAP + 1}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const lines: string[] = [HEADERS.join(',')];
    const truncated = rows.length > ROW_CAP;
    const emitted = truncated ? rows.slice(0, ROW_CAP) : rows;

    for (const r of emitted) {
      lines.push(
        csvRow([
          toYmd(r.day),
          r.currency ?? '',
          toNumericString(r.count),
          toNumericString(r.amount_minor),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, days },
        'Admin cashback-activity CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `cashback-activity-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin cashback-activity CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
