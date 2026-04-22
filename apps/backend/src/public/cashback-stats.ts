/**
 * Public cashback-stats endpoint (ADR 009 / 015).
 *
 * `GET /api/public/cashback-stats` — fleet-wide aggregate for the
 * unauthenticated landing page:
 *   - totalUsersWithCashback: distinct users with a `cashback`
 *     credit_transactions row.
 *   - totalCashbackPaidMinor: sum of positive `cashback`-type
 *     movements across all currencies, grouped. Denominated per-
 *     currency because fleet-wide "total" only makes sense when
 *     you know the denomination.
 *   - fulfilledOrders: count of `state = fulfilled` orders.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500. DB errors fall back to a last-known-good snapshot
 *     if we have one; otherwise return zeros. An unauthenticated
 *     visitor should never see a server error on the landing page
 *     regardless of backend health.
 *   - `Cache-Control: public, max-age=300` (5 min). This is
 *     marketing data, not transactional — a brief staleness is
 *     preferable to hammering the DB on every landing-page hit.
 *   - On the fallback path we emit `max-age=60` instead — serve
 *     stale briefly, refresh soon.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-cashback-stats' });

export interface PerCurrencyCashback {
  currency: string;
  /** bigint-as-string, minor units. */
  amountMinor: string;
}

export interface PublicCashbackStats {
  totalUsersWithCashback: number;
  totalCashbackByCurrency: PerCurrencyCashback[];
  fulfilledOrders: number;
  /** ISO-8601 timestamp of when this snapshot was computed. */
  asOf: string;
}

// In-memory last-known-good snapshot. The tier that makes this
// "never 500" — if the DB read throws, we serve this instead.
// Reset on process restart; fallback-to-zero is the bootstrap state.
let lastKnownGood: PublicCashbackStats | null = null;

interface UsersRow {
  n: string | number;
}
interface OrdersRow {
  n: string | number;
}
interface CashbackRow {
  currency: string;
  amount_minor: string | number | bigint;
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

async function computeStats(): Promise<PublicCashbackStats> {
  // COUNT(DISTINCT user_id) WHERE type = 'cashback'. One row back.
  const usersResult = await db.execute(sql`
    SELECT COUNT(DISTINCT user_id)::text AS n
    FROM credit_transactions
    WHERE type = 'cashback'
  `);
  const usersRows = (
    Array.isArray(usersResult)
      ? (usersResult as unknown as UsersRow[])
      : ((usersResult as unknown as { rows?: UsersRow[] }).rows ?? [])
  ) as UsersRow[];

  const ordersResult = await db.execute(sql`
    SELECT COUNT(*)::text AS n FROM orders WHERE state = 'fulfilled'
  `);
  const ordersRows = (
    Array.isArray(ordersResult)
      ? (ordersResult as unknown as OrdersRow[])
      : ((ordersResult as unknown as { rows?: OrdersRow[] }).rows ?? [])
  ) as OrdersRow[];

  const cashbackResult = await db.execute(sql`
    SELECT
      currency,
      COALESCE(SUM(amount_minor), 0)::bigint AS amount_minor
    FROM credit_transactions
    WHERE type = 'cashback'
    GROUP BY currency
    ORDER BY currency ASC
  `);
  const cashbackRows = (
    Array.isArray(cashbackResult)
      ? (cashbackResult as unknown as CashbackRow[])
      : ((cashbackResult as unknown as { rows?: CashbackRow[] }).rows ?? [])
  ) as CashbackRow[];

  return {
    totalUsersWithCashback: toNumber(usersRows[0]?.n ?? 0),
    fulfilledOrders: toNumber(ordersRows[0]?.n ?? 0),
    totalCashbackByCurrency: cashbackRows.map((r) => ({
      currency: r.currency,
      amountMinor: toStringBigint(r.amount_minor),
    })),
    asOf: new Date().toISOString(),
  };
}

/** Test-only: reset the last-known-good snapshot. Exported without underscore-prefix convention to keep the hatch obvious. */
export function __resetPublicCashbackStatsCache(): void {
  lastKnownGood = null;
}

export async function publicCashbackStatsHandler(c: Context): Promise<Response> {
  try {
    const snapshot = await computeStats();
    lastKnownGood = snapshot;
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicCashbackStats>(snapshot);
  } catch (err) {
    log.error({ err }, 'Public cashback-stats computation failed — serving fallback');
    // Fallback cadence: serve stale briefly so the DB has time to
    // recover before the CDN asks again.
    c.header('cache-control', 'public, max-age=60');
    if (lastKnownGood !== null) {
      return c.json<PublicCashbackStats>(lastKnownGood);
    }
    // Bootstrap path — no prior snapshot. Serve zeros rather than
    // 5xx; the landing page renders "— cashback earned so far" etc.
    return c.json<PublicCashbackStats>({
      totalUsersWithCashback: 0,
      fulfilledOrders: 0,
      totalCashbackByCurrency: [],
      asOf: new Date().toISOString(),
    });
  }
}
