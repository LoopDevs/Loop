/**
 * Admin supplier-spend activity CSV export (ADR 013 / 015 / 018).
 *
 * `GET /api/admin/supplier-spend/activity.csv` — daily × per-currency
 * supplier-spend aggregate as RFC 4180 CSV. Finance runs this at
 * month-end to reconcile CTX's invoice against our ledger: the
 * `wholesale_minor` column is the per-currency total they should
 * match.
 *
 * Shape (one row per (day, currency)):
 *   day,currency,count,face_value_minor,wholesale_minor,user_cashback_minor,loop_margin_minor
 *
 * Zero-activity days emit a single row with empty `currency` and
 * all numeric columns at 0 — same convention as cashback-activity
 * and payouts-activity so the output is dense across the window.
 *
 * Window: `?days=<N>` (default 31, cap 366 per ADR 018). Row cap
 * 10 000. Every money column is bigint-as-string. Bucketed on
 * `fulfilled_at::date` so the row aligns with when CTX actually
 * shipped the good — matches the JSON sibling
 * `/api/admin/supplier-spend/activity`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-supplier-spend-activity-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = [
  'day',
  'currency',
  'count',
  'face_value_minor',
  'wholesale_minor',
  'user_cashback_minor',
  'loop_margin_minor',
] as const;

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
  face_value_minor: string | number | bigint;
  wholesale_minor: string | number | bigint;
  user_cashback_minor: string | number | bigint;
  loop_margin_minor: string | number | bigint;
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

export async function adminSupplierSpendActivityCsvHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
    // A2-904: GROUP BY charge_currency. Per orders/repo.ts, the
    // wholesale / cashback / margin minor-unit sums are denominated
    // in charge_currency (home currency). Grouping by catalog
    // currency mixed them. `currency` CSV column name preserved for
    // wire-compat but now reflects the charge_currency.
    const result = await db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          (CURRENT_DATE - (${days - 1}::int))::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS d
      )
      SELECT
        days.d::text                                       AS day,
        o.charge_currency                                  AS currency,
        COUNT(o.id)::bigint                                AS count,
        COALESCE(SUM(o.face_value_minor), 0)::bigint       AS face_value_minor,
        COALESCE(SUM(o.wholesale_minor), 0)::bigint        AS wholesale_minor,
        COALESCE(SUM(o.user_cashback_minor), 0)::bigint    AS user_cashback_minor,
        COALESCE(SUM(o.loop_margin_minor), 0)::bigint      AS loop_margin_minor
      FROM days
      LEFT JOIN orders o
        ON o.state = 'fulfilled'
        AND o.fulfilled_at IS NOT NULL
        AND o.fulfilled_at::date = days.d
      GROUP BY days.d, o.charge_currency
      ORDER BY days.d ASC, o.charge_currency ASC NULLS LAST
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
          toNumericString(r.face_value_minor),
          toNumericString(r.wholesale_minor),
          toNumericString(r.user_cashback_minor),
          toNumericString(r.loop_margin_minor),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, days },
        'Admin supplier-spend-activity CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `supplier-spend-activity-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin supplier-spend-activity CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
