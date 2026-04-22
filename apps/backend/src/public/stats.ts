/**
 * Public marketing-surface stats (`GET /api/public/stats`).
 *
 * Unauthenticated, aggressively cached. The web and marketing pages
 * render a "Loop has paid £X to Y users across Z merchants" line;
 * keeping this behind auth would either force a login wall on the
 * marketing home or push the numbers into the web bundle (stale +
 * fragile). A public endpoint with a one-hour CDN cache is the right
 * shape.
 *
 * Deliberately narrow: aggregates only. No per-user or per-merchant
 * identifiers. ADR 009's credit ledger is the authoritative source
 * for the cashback totals; fulfilled-order counts and merchant
 * diversity come from `orders`.
 *
 * Currency keying: the `paidCashbackMinor` map keys on the
 * `credit_transactions.currency` (the user's home currency at the
 * time of credit) so the three home currencies (USD/GBP/EUR) each
 * get their own bucket. Any currency the schema picks up via a
 * future home-currency extension surfaces automatically.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditTransactions, orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-stats' });

export interface PublicStats {
  /**
   * Total cashback credited lifetime, keyed by currency. BigInt-string
   * minor units so precision round-trips for arbitrarily-large totals.
   * Excludes negative-sign rows (spend / withdrawal) — this is the
   * "handed out" number, not the "currently owed" number.
   */
  paidCashbackMinor: Record<string, string>;
  /** Number of distinct users who have received at least one cashback credit. */
  paidUserCount: string;
  /** Number of distinct merchants with at least one fulfilled order. */
  merchantsWithOrders: string;
  /** Number of fulfilled orders lifetime. */
  fulfilledOrderCount: string;
}

/** GET /api/public/stats */
export async function publicStatsHandler(c: Context): Promise<Response> {
  try {
    // Cashback totals per currency. `amountMinor > 0` filters out any
    // malformed rows; the DB CHECK already guarantees cashback entries
    // are positive, but belt-and-braces matters for a public-facing
    // number where a negative drift would look terrible.
    const cashbackRows = await db
      .select({
        currency: creditTransactions.currency,
        total: sql<string>`COALESCE(SUM(${creditTransactions.amountMinor}), 0)::text`,
      })
      .from(creditTransactions)
      .where(sql`${creditTransactions.type} = 'cashback' AND ${creditTransactions.amountMinor} > 0`)
      .groupBy(creditTransactions.currency);

    const paidCashbackMinor: Record<string, string> = {};
    for (const row of cashbackRows) paidCashbackMinor[row.currency] = row.total;

    // Distinct user count — anyone who's ever earned cashback.
    const [{ count: paidUserCountRaw } = { count: '0' }] = await db
      .select({
        count: sql<string>`COUNT(DISTINCT ${creditTransactions.userId})::text`,
      })
      .from(creditTransactions)
      .where(
        sql`${creditTransactions.type} = 'cashback' AND ${creditTransactions.amountMinor} > 0`,
      );

    // Order-side aggregates.
    const [{ merchantsCount = '0', fulfilledCount = '0' } = {}] = await db
      .select({
        merchantsCount: sql<string>`COUNT(DISTINCT ${orders.merchantId})::text`,
        fulfilledCount: sql<string>`COUNT(*)::text`,
      })
      .from(orders)
      .where(sql`${orders.state} = 'fulfilled'`);

    const response: PublicStats = {
      paidCashbackMinor,
      paidUserCount: paidUserCountRaw,
      merchantsWithOrders: merchantsCount,
      fulfilledOrderCount: fulfilledCount,
    };

    // One-hour public cache — this is a slow-moving aggregate on a
    // public surface; serving from CDN 60 minutes out of date is fine.
    // Prevents a campaign landing page from hammering the backend on
    // every tab open.
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(response);
  } catch (err) {
    // A failed aggregate shouldn't 500 the marketing page — better to
    // serve empty-shape zeros than take down the hero line. Log the
    // error so ops notices.
    log.error({ err }, 'Public stats query failed');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<PublicStats>({
      paidCashbackMinor: {},
      paidUserCount: '0',
      merchantsWithOrders: '0',
      fulfilledOrderCount: '0',
    });
  }
}
