/**
 * Admin merchant-flywheel-activity CSV export (ADR 011/015/018).
 *
 * `GET /api/admin/merchants/:merchantId/flywheel-activity.csv` —
 * Tier-3 CSV sibling of the JSON flywheel-activity endpoint
 * (#641). Finance / BD run this when prepping a commercial
 * conversation with a merchant ("here's how LOOP-asset adoption
 * at your storefront has trended over the last year") or when
 * negotiating cashback-rate changes against observed recycling
 * behaviour.
 *
 * Shape (one row per day in the window):
 *   day,recycled_count,total_count,recycled_charge_minor,total_charge_minor
 *
 * Zero-activity days emit `day,0,0,0,0` so the output is dense
 * across the window — downstream tools (Excel charts, Sheets
 * pivot tables) don't need gap-filling. Matches the
 * cashback-activity.csv + payouts-activity.csv convention.
 *
 * Window: `?days=<N>` (default 31, cap 366). Row cap 10 000 —
 * even a 366-day pull is 366 rows so the cap is far from
 * binding. Rate-limited 10/min per ADR 018.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-merchant-flywheel-activity-csv' });

const DEFAULT_DAYS = 31;
const MAX_DAYS = 366;
const ROW_CAP = 10_000;
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

const HEADERS = [
  'day',
  'recycled_count',
  'total_count',
  'recycled_charge_minor',
  'total_charge_minor',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
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

function toNumericString(value: string | number | bigint | null): string {
  if (value === null) return '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminMerchantFlywheelActivityCsvHandler(c: Context): Promise<Response> {
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
          toNumericString(r.recycled_count),
          toNumericString(r.total_count),
          toNumericString(r.recycled_charge_minor),
          toNumericString(r.total_charge_minor),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, days, merchantId },
        'Admin merchant flywheel-activity CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${merchantId}-flywheel-activity-${today}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant flywheel-activity CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
