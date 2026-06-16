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
 *
 * CF-29 / x-perf PERF-001: this is a crawler-exposed surface whose
 * three aggregates scan the full `credit_transactions` / `orders`
 * tables. The HTTP `Cache-Control` only deduplicates at a CDN edge —
 * a crawler storm (or many edge regions) still triggers a real
 * recompute per cache-miss. We add a process-level TTL compute cache:
 * `computeStats()` runs at most once per `COMPUTE_TTL_MS`; every other
 * request inside the window serves the memoised snapshot without
 * touching the DB. The three aggregates also now run via `Promise.all`
 * (independent reads, were awaited sequentially), and migration 0036
 * adds `credit_transactions(type, created_at)` so the cashback roll-up
 * is an index range scan rather than a full-table seq scan. Response
 * shape is unchanged.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
// Response shape lives in `@loop/shared` alongside the web's consumer
// (ADR 019 single-source rule). Re-exported below for existing backend
// imports that reference the symbol relative to this module.
import type { PerCurrencyCashback, PublicCashbackStats } from '@loop/shared';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

export type { PerCurrencyCashback, PublicCashbackStats };

const log = logger.child({ handler: 'public-cashback-stats' });

// CF-29 / PERF-001: how long a freshly-computed snapshot is served
// from process memory before the next request triggers a recompute.
// Matches the 5-min HTTP `Cache-Control` so the in-process memo and the
// CDN TTL expire together; a crawler storm inside the window costs zero
// DB queries.
const COMPUTE_TTL_MS = 5 * 60 * 1000;

// In-memory snapshot. Two roles in one cell:
//   1. TTL compute cache (CF-29 / PERF-001) — `computedAt` gates when a
//      recompute is allowed; inside the window we serve `value` straight
//      back without a DB round-trip.
//   2. Last-known-good fallback — the tier that makes this "never 500":
//      if a recompute throws, we serve the last good `value` instead.
// Reset on process restart; fallback-to-zero is the bootstrap state.
let cache: { value: PublicCashbackStats; computedAt: number } | null = null;

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

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

async function computeStats(): Promise<PublicCashbackStats> {
  // CF-29 / PERF-001: the three aggregates are independent reads — run
  // them concurrently rather than awaiting each in series. The
  // `type='cashback'` predicates are served by the
  // `credit_transactions(type, created_at)` index (migration 0036).
  const [usersResult, ordersResult, cashbackResult] = await Promise.all([
    // COUNT(DISTINCT user_id) WHERE type = 'cashback'. One row back.
    db.execute(sql`
      SELECT COUNT(DISTINCT user_id)::text AS n
      FROM credit_transactions
      WHERE type = 'cashback'
    `),
    db.execute(sql`
      SELECT COUNT(*)::text AS n FROM orders WHERE state = 'fulfilled'
    `),
    db.execute(sql`
      SELECT
        currency,
        COALESCE(SUM(amount_minor), 0)::bigint AS amount_minor
      FROM credit_transactions
      WHERE type = 'cashback'
      GROUP BY currency
      ORDER BY currency ASC
    `),
  ]);

  const usersRows = rowsOf<UsersRow>(usersResult);
  const ordersRows = rowsOf<OrdersRow>(ordersResult);
  const cashbackRows = rowsOf<CashbackRow>(cashbackResult);

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

/** Test-only: drop the snapshot entirely (both the TTL memo and the last-known-good fallback). Exported without underscore-prefix convention to keep the hatch obvious. */
export function __resetPublicCashbackStatsCache(): void {
  cache = null;
}

/** Test-only: mark the existing snapshot stale without dropping it, so the next request recomputes while the last-known-good fallback stays available. */
export function __expirePublicCashbackStatsCache(): void {
  if (cache !== null) cache.computedAt = 0;
}

export async function publicCashbackStatsHandler(c: Context): Promise<Response> {
  // CF-29 / PERF-001: serve the memoised snapshot without a DB round-trip
  // while it is still fresh. This is the storm guard — a crawler burst
  // inside the TTL window costs zero queries regardless of how many
  // requests slip past the CDN edge.
  if (cache !== null && Date.now() - cache.computedAt < COMPUTE_TTL_MS) {
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicCashbackStats>(cache.value);
  }

  try {
    const snapshot = await computeStats();
    cache = { value: snapshot, computedAt: Date.now() };
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicCashbackStats>(snapshot);
  } catch (err) {
    log.error({ err }, 'Public cashback-stats computation failed — serving fallback');
    // Fallback cadence: serve stale briefly so the DB has time to
    // recover before the CDN asks again.
    c.header('cache-control', 'public, max-age=60');
    if (cache !== null) {
      // Last-known-good — a recompute failed but we have a prior good
      // snapshot. (Its TTL has lapsed, hence we got here.)
      return c.json<PublicCashbackStats>(cache.value);
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
