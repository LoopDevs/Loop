/**
 * Admin per-merchant flow view (ADR 011 / 015).
 *
 * `GET /api/admin/merchant-flows` — aggregates fulfilled `orders` by
 * `(merchant_id, charge_currency)` so the admin /admin/cashback page
 * can render each merchant's lifetime wholesale / cashback / margin
 * split alongside its *configured* split from `merchant_cashback_configs`.
 *
 * Ops use this to answer: "Is the 3% user cashback on Tesco actually
 * costing us what we expected?" A merchant whose actual margin
 * under-delivers vs. config is a tripwire for CTX discount drift or
 * config error.
 *
 * Mirrors the charge-currency grouping used by /admin/treasury
 * orderFlows, but adds `merchantId` as a second dimension. Currencies
 * inside a merchant bucket are rare (a US-region merchant is sold
 * only to USD home-currency users today), but the schema supports
 * cross-currency so the API stays correct as ADR 015 expands.
 */
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-merchant-flows' });

export interface MerchantFlow {
  merchantId: string;
  /** Currency the user was charged in. Key'd alongside merchantId. */
  currency: string;
  /** Number of fulfilled orders in this bucket. BigInt-string count. */
  count: string;
  /** Sum of gift-card face values in the bucket currency's minor units. */
  faceValueMinor: string;
  /** Total paid to CTX (supplier) for this bucket. */
  wholesaleMinor: string;
  /** Total cashback credited to users for this bucket. */
  userCashbackMinor: string;
  /** Total kept by Loop. */
  loopMarginMinor: string;
}

export interface MerchantFlowsResponse {
  flows: MerchantFlow[];
}

/** GET /api/admin/merchant-flows */
export async function adminMerchantFlowsHandler(c: Context): Promise<Response> {
  try {
    const rows = await db
      .select({
        merchantId: orders.merchantId,
        currency: orders.chargeCurrency,
        count: sql<string>`COUNT(*)::text`,
        faceValue: sql<string>`COALESCE(SUM(${orders.faceValueMinor}), 0)::text`,
        wholesale: sql<string>`COALESCE(SUM(${orders.wholesaleMinor}), 0)::text`,
        userCashback: sql<string>`COALESCE(SUM(${orders.userCashbackMinor}), 0)::text`,
        loopMargin: sql<string>`COALESCE(SUM(${orders.loopMarginMinor}), 0)::text`,
      })
      .from(orders)
      .where(eq(orders.state, 'fulfilled'))
      .groupBy(orders.merchantId, orders.chargeCurrency)
      .orderBy(orders.merchantId);

    const flows: MerchantFlow[] = rows.map((r) => ({
      merchantId: r.merchantId,
      currency: r.currency,
      count: r.count,
      faceValueMinor: r.faceValue,
      wholesaleMinor: r.wholesale,
      userCashbackMinor: r.userCashback,
      loopMarginMinor: r.loopMargin,
    }));

    log.debug({ buckets: flows.length }, 'admin merchant-flows served');
    return c.json<MerchantFlowsResponse>({ flows });
  } catch (err) {
    // A2-507: match sibling admin handlers that route errors through
    // their handler-scoped logger bindings before the global onError
    // fallback. The log line + request-id correlation is what ops needs
    // to debug a specific /admin/cashback load failure.
    log.error({ err }, 'admin merchant-flows query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load merchant flows' }, 500);
  }
}
