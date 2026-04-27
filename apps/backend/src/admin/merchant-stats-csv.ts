/**
 * Admin merchant-stats CSV export (ADR 011 / 015 / 018).
 *
 * `GET /api/admin/merchant-stats.csv` — finance / negotiation export
 * of per-merchant cashback stats across fulfilled orders in a
 * window. Same aggregate as the JSON `/admin/merchant-stats` but
 * flattened for spreadsheet consumption — ops uses it when
 * preparing CTX wholesale-rate negotiation decks (the "here's the
 * 30 merchants that drive our revenue" slide).
 *
 * Shape: one row per (merchant, currency) — most merchants emit
 * one row, the GROUP BY handles the rare multi-currency case.
 * bigint columns as strings. Orders ranked by Loop margin DESC
 * so the top earners surface first.
 *
 * Window: `?since=<iso>` (default 31 days, cap 366 per ADR 018).
 * Row cap 10 000 with `__TRUNCATED__` sentinel on overflow.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-merchant-stats-csv' });

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const ROW_CAP = 10_000;

const HEADERS = [
  'merchant_id',
  'currency',
  'order_count',
  'unique_user_count',
  'face_value_minor',
  'wholesale_minor',
  'user_cashback_minor',
  'loop_margin_minor',
  'last_fulfilled_at',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  merchant_id: string;
  currency: string;
  order_count: string | number | bigint;
  unique_user_count: string | number | bigint;
  face_value_minor: string | number | bigint;
  wholesale_minor: string | number | bigint;
  user_cashback_minor: string | number | bigint;
  loop_margin_minor: string | number | bigint;
  last_fulfilled_at: string | Date;
}

function toNumericString(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

function toIso(value: string | Date): string {
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return value.toISOString();
}

export async function adminMerchantStatsCsvHandler(c: Context): Promise<Response> {
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
        ${orders.merchantId} AS merchant_id,
        ${orders.currency}    AS currency,
        COUNT(*)::bigint      AS order_count,
        COUNT(DISTINCT ${orders.userId})::bigint AS unique_user_count,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint    AS face_value_minor,
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::bigint    AS wholesale_minor,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS user_cashback_minor,
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint   AS loop_margin_minor,
        MAX(${orders.fulfilledAt}) AS last_fulfilled_at
      FROM ${orders}
      WHERE ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since.toISOString()}
      GROUP BY ${orders.merchantId}, ${orders.currency}
      ORDER BY loop_margin_minor DESC, order_count DESC
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
          r.currency,
          toNumericString(r.order_count),
          toNumericString(r.unique_user_count),
          toNumericString(r.face_value_minor),
          toNumericString(r.wholesale_minor),
          toNumericString(r.user_cashback_minor),
          toNumericString(r.loop_margin_minor),
          toIso(r.last_fulfilled_at),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin merchant-stats CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `merchant-stats-${since.toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin merchant-stats CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
