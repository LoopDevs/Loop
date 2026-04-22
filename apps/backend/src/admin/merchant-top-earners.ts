/**
 * Admin per-merchant top-earners leaderboard (#655).
 *
 * `GET /api/admin/merchants/:merchantId/top-earners?days=30&limit=10` —
 * ranked list of users who earned the most cashback at one
 * merchant in a time window. Inverse axis of the existing
 * per-user `user-cashback-by-merchant` endpoint:
 *   - per-user view answers "where does Alice earn cashback?"
 *   - per-merchant view answers "who earns cashback at Amazon?"
 *
 * Powers a "Top earners" card on `/admin/merchants/:merchantId`
 * so BD / support can see the whales at a specific merchant —
 * which anchors "this merchant matters to Loop" in the
 * commercial conversation and helps target outreach ("we saw
 * you spent £300 at Amazon last month, here's an offer").
 *
 * Source of truth: `orders.user_cashback_minor` summed grouped
 * by (user_id, charge_currency) over fulfilled orders at the
 * merchant. Same pattern as the scalar cashback-summary (#625)
 * — avoids a JOIN through credit_transactions and keeps the
 * number stable if a ledger row is delayed.
 *
 * Joins against `users` so the response carries the user email
 * (admin-only view, email is not PII leak — this endpoint is
 * already admin-gated).
 *
 * Invariants:
 *   - Default window: 30 days. Cap 366 (matches top-users).
 *   - Default limit: 10. Cap 100.
 *   - Only `state='fulfilled'` with `fulfilled_at IS NOT NULL`
 *     — cashback is minted at fulfillment.
 *   - Sorted by summed cashback desc, then user email asc for
 *     stable tie-break across refreshes.
 *   - bigint-as-string on cashback sums.
 *   - Multi-currency: rows are (user, currency) so one user
 *     can appear twice if they have fulfilled orders at the
 *     merchant in two charge currencies.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, users } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-top-earners' });

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

export interface MerchantTopEarnerRow {
  userId: string;
  email: string;
  currency: string;
  orderCount: number;
  /** SUM(user_cashback_minor) for this (user, currency) in the window. bigint-as-string. */
  cashbackMinor: string;
  /** SUM(charge_minor) — "cashback as % of their spend at this merchant" denominator. */
  chargeMinor: string;
}

export interface MerchantTopEarnersResponse {
  merchantId: string;
  since: string;
  rows: MerchantTopEarnerRow[];
}

interface AggRow {
  user_id: string;
  email: string;
  currency: string;
  order_count: string | number | bigint;
  cashback_minor: string | number | bigint;
  charge_minor: string | number | bigint;
}

function toNumber(value: string | number | bigint): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(value, 10);
}

function toStringBigint(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Math.trunc(value).toString();
  return value;
}

export async function adminMerchantTopEarnersHandler(c: Context): Promise<Response> {
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

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const result = await db.execute<AggRow>(sql`
      SELECT
        ${orders.userId}::text                                AS user_id,
        ${users.email}                                        AS email,
        ${orders.chargeCurrency}                              AS currency,
        COUNT(*)::bigint                                      AS order_count,
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS cashback_minor,
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint       AS charge_minor
      FROM ${orders}
      JOIN ${users} ON ${users.id} = ${orders.userId}
      WHERE ${orders.merchantId} = ${merchantId}
        AND ${orders.state} = 'fulfilled'
        AND ${orders.fulfilledAt} IS NOT NULL
        AND ${orders.fulfilledAt} >= ${since}
      GROUP BY ${orders.userId}, ${users.email}, ${orders.chargeCurrency}
      ORDER BY cashback_minor DESC, email ASC
      LIMIT ${limit}
    `);

    const raw = (
      Array.isArray(result)
        ? (result as AggRow[])
        : ((result as unknown as { rows?: AggRow[] }).rows ?? [])
    ) as AggRow[];

    const rows: MerchantTopEarnerRow[] = raw.map((r) => ({
      userId: r.user_id,
      email: r.email,
      currency: r.currency,
      orderCount: toNumber(r.order_count),
      cashbackMinor: toStringBigint(r.cashback_minor),
      chargeMinor: toStringBigint(r.charge_minor),
    }));

    return c.json<MerchantTopEarnersResponse>({
      merchantId,
      since: since.toISOString(),
      rows,
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant top-earners query failed');
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Failed to compute merchant top earners' },
      500,
    );
  }
}
