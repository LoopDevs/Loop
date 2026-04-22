/**
 * Admin per-merchant cashback-monthly aggregate (#635).
 *
 * `GET /api/admin/merchants/:merchantId/cashback-monthly` — last
 * 12 calendar months of user-cashback emissions on fulfilled
 * orders at one merchant, grouped by (month, chargeCurrency).
 *
 * Sibling of the two cashback-monthly endpoints already live:
 *   - `/api/admin/cashback-monthly`           (fleet-wide)
 *   - `/api/admin/users/:userId/cashback-monthly`  (#633)
 *
 * Sourced from `orders.user_cashback_minor` rather than
 * `credit_transactions` (same choice as the scalar merchant-
 * cashback-summary in #625). Keeps the number stable when a
 * credit_transactions row is delayed and matches the cashback-
 * config audit trail the config was pinned against — no
 * credit_transactions JOIN through `orders`.
 *
 * Bucketed on `fulfilled_at` (not `created_at`) — cashback is
 * minted at fulfillment, so the bucket month is the month the
 * liability actually hit the books. Matches the scalar summary
 * endpoint.
 *
 * Zero-volume merchants return 200 with empty `entries` — a
 * catalog merchant with no orders yet is valid. No existence
 * probe (the catalog is in-memory and the merchant-detail page
 * already renders a dedicated "evicted" message when the id
 * isn't found).
 *
 * Invariants (matches cashback-monthly siblings):
 *   - Fixed 12-month window (current UTC month + previous 11)
 *   - Oldest-first ordering
 *   - One entry per (month, currency)
 *   - bigint-as-string on cashbackMinor
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-cashback-monthly' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

export interface AdminMerchantCashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  /** The order's `charge_currency` (the user's home_currency at order-creation time). */
  currency: string;
  /** SUM(user_cashback_minor) over fulfilled orders in this (month, currency). bigint-as-string. */
  cashbackMinor: string;
}

export interface AdminMerchantCashbackMonthlyResponse {
  merchantId: string;
  entries: AdminMerchantCashbackMonthlyEntry[];
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

export async function adminMerchantCashbackMonthlyHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is required' }, 400);
  }
  if (merchantId.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(merchantId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId is malformed' }, 400);
  }

  try {
    const result = await db.execute(sql`
      SELECT
        DATE_TRUNC('month', ${orders.fulfilledAt} AT TIME ZONE 'UTC') AS month,
        ${orders.chargeCurrency}                                      AS currency,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint          AS cashback_minor
      FROM ${orders}
      WHERE ${orders.merchantId} = ${merchantId}
        AND ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= DATE_TRUNC(
          'month',
          (NOW() AT TIME ZONE 'UTC') - INTERVAL '11 months'
        )
      GROUP BY month, currency
      ORDER BY month ASC, currency ASC
    `);

    const raw = (
      Array.isArray(result)
        ? (result as unknown as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const entries: AdminMerchantCashbackMonthlyEntry[] = raw.map((r) => ({
      month: formatMonth(r.month),
      currency: r.currency,
      cashbackMinor: toStringBigint(r.cashback_minor),
    }));

    return c.json<AdminMerchantCashbackMonthlyResponse>({ merchantId, entries });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant cashback-monthly query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute merchant cashback-monthly' },
      500,
    );
  }
}
