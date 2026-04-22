/**
 * Public cashback headline numbers (ADR 011 / 015).
 *
 * `GET /api/public/cashback-stats` — unauthenticated aggregate over
 * `merchant_cashback_configs` for the loopfinance.io hero section
 * ("99 brands offering cashback · avg 12% · up to 20%").
 *
 * Single GROUP-less aggregate query; only active configs with non-zero
 * user cashback are counted — a 0% or paused config isn't a "cashback
 * deal" from a marketing perspective. Returns zero-shaped response
 * when the table is empty so the hero copy always has numbers to
 * render.
 */
import type { Context } from 'hono';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-cashback-stats' });

export interface PublicCashbackStatsResponse {
  /** Count of active configs with user_cashback_pct > 0. */
  merchantsWithCashback: number;
  /** Average user_cashback_pct across those configs, 2 decimals as string. */
  averageCashbackPct: string;
  /** Max user_cashback_pct across those configs, 2 decimals as string. */
  topCashbackPct: string;
}

interface StatsRow extends Record<string, unknown> {
  n: string | number;
  avgPct: string | number | null;
  maxPct: string | null;
}

function zero(): PublicCashbackStatsResponse {
  return {
    merchantsWithCashback: 0,
    averageCashbackPct: '0.00',
    topCashbackPct: '0.00',
  };
}

/**
 * Format a Postgres numeric to the 2-decimal string shape the rest of
 * the cashback surface uses. Source is already numeric(5,2) or avg-of-
 * numeric(5,2), so precision is fine — we just want a consistent wire
 * form.
 */
function formatPct(value: string | number | null): string {
  if (value === null || value === undefined) return '0.00';
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (Number.isNaN(n)) return '0.00';
  return n.toFixed(2);
}

export async function publicCashbackStatsHandler(c: Context): Promise<Response> {
  try {
    const result = await db.execute<StatsRow>(sql`
      SELECT
        COUNT(*)::bigint AS n,
        AVG(${merchantCashbackConfigs.userCashbackPct}) AS "avgPct",
        MAX(${merchantCashbackConfigs.userCashbackPct}) AS "maxPct"
      FROM ${merchantCashbackConfigs}
      WHERE ${and(
        eq(merchantCashbackConfigs.active, true),
        gt(merchantCashbackConfigs.userCashbackPct, '0'),
      )}
    `);
    const rows: StatsRow[] = Array.isArray(result)
      ? (result as StatsRow[])
      : ((result as { rows?: StatsRow[] }).rows ?? []);
    const row = rows[0];

    c.header('Cache-Control', 'public, max-age=300');

    if (row === undefined) {
      return c.json<PublicCashbackStatsResponse>(zero());
    }

    const count = Number(row.n ?? 0);
    // When the WHERE matches zero rows, AVG/MAX come back as null. The
    // zero fallback keeps the marketing UI from rendering "NaN%".
    if (count === 0) {
      return c.json<PublicCashbackStatsResponse>(zero());
    }
    return c.json<PublicCashbackStatsResponse>({
      merchantsWithCashback: count,
      averageCashbackPct: formatPct(row.avgPct),
      topCashbackPct: formatPct(row.maxPct),
    });
  } catch (err) {
    // Public marketing surface — never 500 to a landing-page visitor.
    // Log the problem, serve the zero shape so the hero still renders.
    log.error({ err }, 'Public cashback-stats query failed');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<PublicCashbackStatsResponse>(zero());
  }
}
