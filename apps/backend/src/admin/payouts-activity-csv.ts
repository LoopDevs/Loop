/**
 * Admin payouts-activity CSV export (ADR 015 / 016 / 018).
 *
 * `GET /api/admin/payouts-activity.csv` — daily × per-asset
 * confirmed-payout aggregate as RFC 4180 CSV. Finance runs this
 * alongside `/api/admin/cashback-activity.csv` at month-end to
 * reconcile **creation** (cashback minted) against **settlement**
 * (on-chain payouts confirmed) at daily resolution.
 *
 * Shape (one row per (day, asset_code)):
 *   day,asset_code,payout_count,stroops
 *
 * Zero-activity days emit a single row with empty `asset_code`,
 * `0,0` — so the output is dense across the window and downstream
 * tools can render the series without gap-filling client-side.
 * Same convention as cashback-activity.csv.
 *
 * Window: `?days=<N>` (default 31, cap 366 per ADR 018). Row cap
 * 10 000. `stroops` is bigint-as-string (7-decimal Stellar units,
 * exceeds Number.MAX_SAFE_INTEGER on non-trivial payout volume).
 *
 * Bucketed on `confirmed_at::date` — the day the liability
 * actually settled, not the day the row was queued. Matches the
 * JSON sibling `/api/admin/payouts-activity`.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-payouts-activity-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = ['day', 'asset_code', 'payout_count', 'stroops'] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  day: string | Date;
  asset_code: string | null;
  count: string | number | bigint;
  stroops: string | number | bigint;
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

export async function adminPayoutsActivityCsvHandler(c: Context): Promise<Response> {
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
        days.d::text                                AS day,
        pp.asset_code                               AS asset_code,
        COUNT(pp.id)::bigint                        AS count,
        COALESCE(SUM(pp.amount_stroops), 0)::bigint AS stroops
      FROM days
      LEFT JOIN pending_payouts pp
        ON pp.state = 'confirmed'
        AND pp.confirmed_at IS NOT NULL
        AND pp.confirmed_at::date = days.d
      GROUP BY days.d, pp.asset_code
      ORDER BY days.d ASC, pp.asset_code ASC NULLS LAST
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
          r.asset_code ?? '',
          toNumericString(r.count),
          toNumericString(r.stroops),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, days },
        'Admin payouts-activity CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `payouts-activity-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin payouts-activity CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
