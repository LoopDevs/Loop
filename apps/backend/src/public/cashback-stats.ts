// public cashback-stats endpoint — ADR 009, 015, 020, 052; CF-29, PERF-001
import type { Context } from 'hono';
import type { PerCurrencyCashback, PublicCashbackStats } from '@loop/shared';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

export type { PerCurrencyCashback, PublicCashbackStats };

const log = logger.child({ handler: 'public-cashback-stats' });

// CF-29 / PERF-001: matches 5-min HTTP Cache-Control so in-process memo and CDN TTL expire together
const COMPUTE_TTL_MS = 5 * 60 * 1000;

// CF-29 / PERF-001: TTL compute cache + last-known-good fallback for "never 500"
let cache: { value: PublicCashbackStats; computedAt: number } | null = null;

async function computeStats(): Promise<PublicCashbackStats> {
  // ADR 052: cashback is per-order checkout discount, so all aggregates come from one fulfilled-orders scan
  const fulfilled = await db.collection('orders').findMany({ state: 'fulfilled' });
  const usersWithCashback = new Set<string>();
  const totals = new Map<string, number>();
  for (const order of fulfilled) {
    if (order.userCashbackMinor > 0) {
      usersWithCashback.add(order.userId);
      totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.userCashbackMinor);
    }
  }
  return {
    totalUsersWithCashback: usersWithCashback.size,
    fulfilledOrders: fulfilled.length,
    totalCashbackByCurrency: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, amountMinor]) => ({ currency, amountMinor: String(amountMinor) })),
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
  // CF-29 / PERF-001: serve memoised snapshot while fresh; storm guard for crawler bursts
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
    // Fallback cadence: serve stale briefly so DB has time to recover
    c.header('cache-control', 'public, max-age=60');
    if (cache !== null) {
      // Last-known-good — recompute failed but prior good snapshot exists
      return c.json<PublicCashbackStats>(cache.value);
    }
    // Bootstrap path — no prior snapshot; serve zeros rather than 5xx
    return c.json<PublicCashbackStats>({
      totalUsersWithCashback: 0,
      fulfilledOrders: 0,
      totalCashbackByCurrency: [],
      asOf: new Date().toISOString(),
    });
  }
}
