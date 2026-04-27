/**
 * Admin users-recycling-activity CSV export (ADR 011 / 015 / 018).
 *
 * `GET /api/admin/users/recycling-activity.csv` — finance-grade
 * export of the 90-day "who's recycling right now?" leaderboard
 * (#611). Same aggregate as the JSON surface, flattened for
 * spreadsheet consumption.
 *
 * Complement to the sibling admin CSV exports:
 *   - /api/admin/payouts.csv              (backlog)
 *   - /api/admin/users/:id/credit-transactions.csv (per-user ledger)
 *   - /api/admin/merchants/flywheel-share.csv (merchant axis)
 *   - this one                            (user axis)
 *
 * Same Tier-3 contract as every other admin CSV:
 *   - 10/min rate limit (finance pull, not polling)
 *   - 90-day window is fixed (mirrors the JSON endpoint's
 *     window — the signal is "recent activity", not "since
 *     launched")
 *   - 10 000 row cap with `__TRUNCATED__` sentinel on overflow
 *   - bigint columns as strings; RFC-4180 CSV escape for email
 *   - content-disposition: attachment with dated filename
 *
 * Zero-recycle users omitted by construction (INNER JOIN on
 * orders.payment_method='loop_asset'), same as the JSON.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { csvEscape } from './csv-escape.js';

const log = logger.child({ handler: 'admin-users-recycling-activity-csv' });

const WINDOW_DAYS = 90;
const ROW_CAP = 10_000;

const HEADERS = [
  'user_id',
  'email',
  'currency',
  'last_recycled_at',
  'recycled_order_count',
  'recycled_charge_minor',
] as const;

function csvRow(values: Array<string | null | undefined>): string {
  return values.map((v) => csvEscape(v ?? null)).join(',');
}

interface AggRow {
  user_id: string;
  email: string;
  currency: string;
  last_recycled_at: string | Date;
  recycled_order_count: string | number | bigint;
  recycled_charge_minor: string | number | bigint;
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

export async function adminUsersRecyclingActivityCsvHandler(c: Context): Promise<Response> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    const result = await db.execute(sql`
      SELECT
        u.id              AS user_id,
        u.email           AS email,
        u.home_currency   AS currency,
        MAX(o.created_at) AS last_recycled_at,
        COUNT(o.id)::bigint                         AS recycled_order_count,
        COALESCE(SUM(o.charge_minor), 0)::bigint    AS recycled_charge_minor
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
      WHERE o.payment_method = 'loop_asset'
        AND o.created_at >= ${since.toISOString()}
      GROUP BY u.id, u.email, u.home_currency
      ORDER BY MAX(o.created_at) DESC
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
          r.user_id,
          r.email,
          r.currency,
          toIso(r.last_recycled_at),
          toNumericString(r.recycled_order_count),
          toNumericString(r.recycled_charge_minor),
        ]),
      );
    }

    if (truncated) {
      log.warn(
        { rowCount: rows.length, since: since.toISOString() },
        'Admin users-recycling-activity CSV truncated — narrow the window',
      );
      lines.push(csvRow(['__TRUNCATED__']));
    }

    const body = lines.join('\r\n') + '\r\n';
    const filename = `users-recycling-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin users-recycling-activity CSV failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to build CSV' }, 500);
  }
}
