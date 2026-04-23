/**
 * Admin cashback-realization daily trend CSV (ADR 009 / 015 / 018).
 *
 * `GET /api/admin/cashback-realization/daily.csv` — Tier-3 finance
 * export of the daily realization time-series shipped in #731.
 * Paired with `/api/admin/cashback-activity.csv`: cashback-activity
 * is "how much did users earn each day"; this is "how much of the
 * daily emission has been recycled vs still outstanding".
 *
 * Shape (one row per (day, currency)):
 *   day,currency,earned_minor,spent_minor,recycled_bps
 *
 * Zero-activity days (LEFT JOIN nulls on the currency column) are
 * dropped so a spreadsheet pivot over the file doesn't create a
 * spurious all-zero row per day. The companion JSON endpoint does
 * the same filtering for the sparkline.
 *
 * Window: `?days=<N>` (default 31, cap 366 per ADR 018). Row cap
 * 10 000. `recycled_bps` is an integer (0..10 000) via the shared
 * `recycledBps()` helper so the CSV can't disagree with what the
 * /admin/cashback-realization card renders.
 *
 * Rate-limit: 10/min — this is finance month-end, not a sparkline
 * poll. Response is `Cache-Control: private, no-store`, attachment
 * disposition — standard Tier-3 CSV discipline.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { recycledBps } from '@loop/shared';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-realization-daily-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = ['day', 'currency', 'earned_minor', 'spent_minor', 'recycled_bps'] as const;

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
  earned_minor: string | number | bigint | null;
  spent_minor: string | number | bigint | null;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toBigIntSafe(v: string | number | bigint | null): bigint {
  if (v === null) return 0n;
  try {
    if (typeof v === 'bigint') return v;
    return BigInt(String(v).split('.')[0] ?? '0');
  } catch {
    return 0n;
  }
}

export async function adminCashbackRealizationDailyCsvHandler(c: Context): Promise<Response> {
  const daysRaw = c.req.query('days');
  const parsedDays = Number.parseInt(daysRaw ?? `${DEFAULT_DAYS}`, 10);
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );

  try {
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
        COALESCE(
          SUM(ct.amount_minor) FILTER (WHERE ct.type = 'cashback'),
          0
        )::text AS earned_minor,
        ABS(
          COALESCE(
            SUM(ct.amount_minor) FILTER (WHERE ct.type = 'spend'),
            0
          )
        )::text AS spent_minor
      FROM days
      LEFT JOIN credit_transactions ct
        ON ct.created_at::date = days.d
        AND ct.type IN ('cashback', 'spend')
      GROUP BY days.d, ct.currency
      ORDER BY days.d ASC, ct.currency ASC NULLS LAST
      LIMIT ${ROW_CAP + 1}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    // Drop LEFT-JOIN null-currency rows pre-truncation so the row
    // cap counts real signal, not gap days.
    const realRows = rows.filter((r) => r.currency !== null);
    const truncated = realRows.length > ROW_CAP;
    const emitted = truncated ? realRows.slice(0, ROW_CAP) : realRows;

    const lines: string[] = [HEADERS.join(',')];
    for (const r of emitted) {
      const earned = toBigIntSafe(r.earned_minor);
      const spent = toBigIntSafe(r.spent_minor);
      lines.push(
        csvRow([
          toYmd(r.day),
          r.currency ?? '',
          earned.toString(),
          spent.toString(),
          String(recycledBps(earned, spent)),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: realRows.length, days },
        'Admin cashback-realization daily CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `cashback-realization-daily-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin cashback-realization daily CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
