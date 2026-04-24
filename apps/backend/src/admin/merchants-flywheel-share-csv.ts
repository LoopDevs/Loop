/**
 * Admin merchants-flywheel-share CSV export (ADR 011 / 015 / 018).
 *
 * `GET /api/admin/merchants/flywheel-share.csv` — finance-grade
 * export of the per-merchant flywheel leaderboard (#602). Same
 * aggregate as the JSON surface, flattened for spreadsheet use.
 * Complement to the existing `/api/admin/merchant-stats.csv` — that
 * one is the "which merchants drive margin" negotiation deck; this
 * one is the "which merchants are part of the recycling loop"
 * answer.
 *
 * Shape: one row per merchant, sorted by recycled-count DESC. Same
 * filter as the JSON endpoint — merchants with zero recycled orders
 * are omitted server-side (HAVING). bigint columns as strings.
 *
 * Window: `?since=<iso>` (default 31 days, cap 366 per ADR 018).
 * Row cap 10 000 with `__TRUNCATED__` sentinel on overflow.
 *
 * Auth / rate-limit: admin-gated via the middleware mounted in
 * app.ts; Tier-3 10/min rate limit matches every other admin CSV.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-merchants-flywheel-share-csv' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'merchant_id',
  'total_fulfilled_count',
  'recycled_order_count',
  'recycled_charge_minor',
  'total_charge_minor',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  merchant_id: string;
  total_fulfilled_count: string | number | bigint;
  recycled_order_count: string | number | bigint;
  recycled_charge_minor: string | number | bigint;
  total_charge_minor: string | number | bigint;
}

function toNumericString(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminMerchantsFlywheelShareCsvHandler(c: Context): Promise<Response> {
  const sinceRaw = c.req.query('since');
  let since: Date;
  if (sinceRaw !== undefined && sinceRaw.length > 0) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: 'since must be an ISO-8601 timestamp' },
        400,
      );
    }
    since = d;
  } else {
    since = new Date(Date.now() - DEFAULT_WINDOW_MS);
  }
  if (Date.now() - since.getTime() > MAX_WINDOW_MS) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'since cannot be more than 366 days ago' },
      400,
    );
  }

  try {
    const result = await db.execute(sql`
      SELECT
        ${orders.merchantId}                                  AS merchant_id,
        COUNT(*)::bigint                                      AS total_fulfilled_count,
        COUNT(*) FILTER (
          WHERE ${orders.paymentMethod} = 'loop_asset'
        )::bigint                                             AS recycled_order_count,
        COALESCE(
          SUM(${orders.chargeMinor}) FILTER (
            WHERE ${orders.paymentMethod} = 'loop_asset'
          ),
          0
        )::bigint                                             AS recycled_charge_minor,
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint       AS total_charge_minor
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since}
      GROUP BY ${orders.merchantId}
      HAVING COUNT(*) FILTER (WHERE ${orders.paymentMethod} = 'loop_asset') > 0
      ORDER BY
        COUNT(*) FILTER (WHERE ${orders.paymentMethod} = 'loop_asset') DESC,
        COUNT(*) DESC
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
          r.merchant_id,
          toNumericString(r.total_fulfilled_count),
          toNumericString(r.recycled_order_count),
          toNumericString(r.recycled_charge_minor),
          toNumericString(r.total_charge_minor),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin merchants-flywheel-share CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `merchants-flywheel-share-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin merchants-flywheel-share CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
