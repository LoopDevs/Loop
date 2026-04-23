/**
 * Admin supplier-margin daily trend CSV (ADR 011/013/015/018/024).
 *
 * `GET /api/admin/supplier-margin/daily.csv` — Tier-3 finance
 * export of the daily supplier-margin series shipped in #742/#740.
 * Paired with `/api/admin/supplier-spend/activity.csv` at month-
 * end: supplier-spend is "what did we pay CTX", this is "what did
 * we keep after the user cashback + wholesale split".
 *
 * Shape (one row per (day, currency)):
 *   day,currency,charge_minor,wholesale_minor,user_cashback_minor,
 *   loop_margin_minor,order_count,margin_bps
 *
 * Zero-activity days (LEFT-JOIN null-currency rows) are dropped
 * pre-truncation so the 10 000 row cap counts real signal.
 * `margin_bps` via the shared helper from supplier-margin.ts so
 * the CSV can't disagree with the JSON endpoint / UI card.
 *
 * Tier-3 discipline: 10/min rate limit, `private, no-store`,
 * attachment content-disposition, `__TRUNCATED__` sentinel row.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { marginBps } from './supplier-margin.js';

const log = logger.child({ handler: 'admin-supplier-margin-daily-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;

const HEADERS = [
  'day',
  'currency',
  'charge_minor',
  'wholesale_minor',
  'user_cashback_minor',
  'loop_margin_minor',
  'order_count',
  'margin_bps',
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
  charge: string | null;
  wholesale: string | null;
  user_cashback: string | null;
  loop_margin: string | null;
  order_count: string | number | bigint | null;
}

function toYmd(day: string | Date): string {
  if (typeof day === 'string') return day.slice(0, 10);
  return day.toISOString().slice(0, 10);
}

function toBigIntSafe(v: string | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

function toIntString(v: string | number | bigint | null): string {
  if (v === null) return '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Math.trunc(v).toString();
  return v;
}

export async function adminSupplierMarginDailyCsvHandler(c: Context): Promise<Response> {
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
      LIMIT ${ROW_CAP + 1}
    `);

    const rows = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const realRows = rows.filter((r) => r.currency !== null);
    const truncated = realRows.length > ROW_CAP;
    const emitted = truncated ? realRows.slice(0, ROW_CAP) : realRows;

    const lines: string[] = [HEADERS.join(',')];
    for (const r of emitted) {
      const charge = toBigIntSafe(r.charge);
      const loopMargin = toBigIntSafe(r.loop_margin);
      lines.push(
        csvRow([
          toYmd(r.day),
          r.currency ?? '',
          charge.toString(),
          toBigIntSafe(r.wholesale).toString(),
          toBigIntSafe(r.user_cashback).toString(),
          loopMargin.toString(),
          toIntString(r.order_count),
          String(marginBps(charge, loopMargin)),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: realRows.length, days },
        'Admin supplier-margin daily CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `supplier-margin-daily-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin supplier-margin daily CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
