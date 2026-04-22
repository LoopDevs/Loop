/**
 * Admin fleet-wide cashback-monthly aggregate (ADR 009 / 015).
 *
 * `GET /api/admin/cashback-monthly` — last 12 calendar months of
 * cashback emissions across every user, grouped by `(month, currency)`.
 * Fleet-wide counterpart to the user-facing `/api/users/me/cashback-
 * monthly`: same 12-month window, same shape, same bigint-as-string
 * wire format — just dropped the `WHERE user_id = ?` so ops can see
 * how much cashback Loop has emitted per month, per currency.
 *
 * Powers the monthly bar chart on `/admin/treasury`, complementing:
 *   - `/admin/cashback-activity`  (daily sparkline, 30-180d)
 *   - `/admin/treasury` .totals   (lifetime cumulative totals)
 *   - `/admin/orders/payment-method-share`  (where cashback flows)
 *
 * The monthly bar chart answers the ADR-015 cashback-flywheel
 * question: "is cashback-emission trending up?" — a prerequisite
 * for loop_asset payment share to rise.
 *
 * Invariants match the user-facing endpoint:
 *   - Fixed 12-month window (current UTC month + previous 11).
 *   - Filtered to `type='cashback'` so spend / withdrawal /
 *     adjustment don't muddy the emission number.
 *   - Oldest-first ordering so the chart renders left-to-right.
 *   - One entry per (month, currency); multi-currency safe.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-cashback-monthly' });

export interface AdminCashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface AdminCashbackMonthlyResponse {
  entries: AdminCashbackMonthlyEntry[];
}

interface AggRow {
  month: string | Date;
  currency: string;
  cashback_minor: string | number | bigint;
}

function formatMonth(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminCashbackMonthlyHandler(c: Context): Promise<Response> {
  try {
    // 12-month window anchored on the current UTC month. Cutoff
    // computed server-side via `date_trunc` so month-length
    // arithmetic stays correct (no JS date drift).
    const result = await db.execute(sql`
      SELECT
        DATE_TRUNC('month', ${creditTransactions.createdAt} AT TIME ZONE 'UTC') AS month,
        ${creditTransactions.currency}                                           AS currency,
        COALESCE(SUM(${creditTransactions.amountMinor}), 0)::bigint              AS cashback_minor
      FROM ${creditTransactions}
      WHERE ${creditTransactions.type} = 'cashback'
        AND ${creditTransactions.createdAt} >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months'
      GROUP BY month, currency
      ORDER BY month ASC, currency ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const entries: AdminCashbackMonthlyEntry[] = raw.map((r) => ({
      month: formatMonth(r.month),
      currency: r.currency,
      cashbackMinor: toStringBigint(r.cashback_minor),
    }));

    return c.json<AdminCashbackMonthlyResponse>({ entries });
  } catch (err) {
    log.error({ err }, 'Admin cashback-monthly query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute cashback-monthly' }, 500);
  }
}
