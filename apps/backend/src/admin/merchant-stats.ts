/**
 * Admin per-merchant stats (ADR 011 / 015).
 *
 * `GET /api/admin/merchants/:merchantId/stats` — aggregates every
 * fulfilled order for one merchant, grouped by `chargeCurrency`, so
 * admins tuning `merchant_cashback_configs` can see "we paid £Y of
 * cashback on £X of Amazon fulfilments this year; current margin is
 * £Z." One round-trip, Postgres does the grouping.
 *
 * Paired with the per-merchant-config history endpoint
 * (`/merchant-cashback-configs/:merchantId/history`) on the same
 * admin merchant page.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-stats' });

export interface MerchantStatsPerCurrency {
  orderCount: number;
  /** Total face value of fulfilled orders, minor units, bigint-safe. */
  faceMinor: string;
  /** Total charged across those fulfilments, minor units. */
  chargeMinor: string;
  /** Total cashback paid to users. */
  userCashbackMinor: string;
  /** Loop's cut after wholesale + user cashback. */
  loopMarginMinor: string;
  /** Wholesale-side commitment (what Loop paid / would pay suppliers). */
  wholesaleMinor: string;
}

export interface AdminMerchantStatsResponse {
  merchantId: string;
  /** Resolved from the in-memory catalog; falls back to merchantId. */
  merchantName: string;
  /**
   * Per-chargeCurrency aggregates. Empty `{}` when there are no
   * fulfilled orders yet — the normal state for a new merchant /
   * cashback rollout.
   */
  fulfilled: Record<string, MerchantStatsPerCurrency>;
  /**
   * ISO-8601 of the most recent `fulfilledAt` across all fulfilled
   * orders for this merchant. Null when there are none.
   */
  lastFulfilledAt: string | null;
}

interface StatsRow extends Record<string, unknown> {
  chargeCurrency: string;
  n: string | number;
  faceSum: string | null;
  chargeSum: string | null;
  cashbackSum: string | null;
  marginSum: string | null;
  wholesaleSum: string | null;
  lastFulfilled: string | Date | null;
}

export async function adminMerchantStatsHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId required' }, 400);
  }

  try {
    const result = await db.execute<StatsRow>(sql`
      SELECT
        ${orders.chargeCurrency} AS "chargeCurrency",
        COUNT(*)::bigint AS n,
        COALESCE(SUM(${orders.faceValueMinor}), 0)::bigint AS "faceSum",
        COALESCE(SUM(${orders.chargeMinor}), 0)::bigint AS "chargeSum",
        COALESCE(SUM(${orders.userCashbackMinor}), 0)::bigint AS "cashbackSum",
        COALESCE(SUM(${orders.loopMarginMinor}), 0)::bigint AS "marginSum",
        COALESCE(SUM(${orders.wholesaleMinor}), 0)::bigint AS "wholesaleSum",
        MAX(${orders.fulfilledAt}) AS "lastFulfilled"
      FROM ${orders}
      WHERE ${orders.merchantId} = ${merchantId}
        AND ${orders.state} = 'fulfilled'
      GROUP BY ${orders.chargeCurrency}
    `);
    const rows: StatsRow[] = Array.isArray(result)
      ? (result as StatsRow[])
      : ((result as { rows?: StatsRow[] }).rows ?? []);

    const fulfilled: AdminMerchantStatsResponse['fulfilled'] = {};
    let lastFulfilledAt: string | null = null;
    for (const row of rows) {
      fulfilled[row.chargeCurrency] = {
        orderCount: Number(row.n),
        faceMinor: (row.faceSum ?? '0').toString(),
        chargeMinor: (row.chargeSum ?? '0').toString(),
        userCashbackMinor: (row.cashbackSum ?? '0').toString(),
        loopMarginMinor: (row.marginSum ?? '0').toString(),
        wholesaleMinor: (row.wholesaleSum ?? '0').toString(),
      };
      if (row.lastFulfilled !== null && row.lastFulfilled !== undefined) {
        const iso =
          row.lastFulfilled instanceof Date
            ? row.lastFulfilled.toISOString()
            : new Date(row.lastFulfilled).toISOString();
        if (lastFulfilledAt === null || iso > lastFulfilledAt) {
          lastFulfilledAt = iso;
        }
      }
    }

    const { merchantsById } = getMerchants();
    const merchantName = merchantsById.get(merchantId)?.name ?? merchantId;

    return c.json<AdminMerchantStatsResponse>({
      merchantId,
      merchantName,
      fulfilled,
      lastFulfilledAt,
    });
  } catch (err) {
    log.error({ err, merchantId }, 'Admin merchant stats failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load merchant stats' }, 500);
  }
}
