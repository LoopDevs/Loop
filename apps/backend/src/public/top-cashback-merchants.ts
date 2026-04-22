/**
 * Public "top cashback" headline endpoint (ADR 011 / 015).
 *
 * `GET /api/public/top-cashback-merchants?limit=10` — unauthenticated
 * marketing list of merchants where Loop pays the highest user-
 * cashback right now. Drives the loopfinance.io hero section
 * "Best cashback deals: Amazon 18%, ASOS 14%, ..." and the same
 * strip on mobile onboarding step 1.
 *
 * Source of truth is `merchant_cashback_configs` — only `active=true`
 * rows count, and only configs with `user_cashback_pct > 0` are
 * surfaced (a 0% config is essentially "configured but not a
 * cashback deal yet"). Merchant name + logo are resolved through
 * the in-memory catalog; rows whose merchant has been evicted
 * upstream are dropped rather than displayed as bare ids —
 * this is a *marketing* surface, unlike the admin-facing fallbacks
 * elsewhere.
 */
import type { Context } from 'hono';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-top-cashback-merchants' });

export interface TopCashbackMerchantEntry {
  merchantId: string;
  merchantName: string;
  logoUrl?: string;
  /** Postgres numeric(5,2) as string — e.g. `"18.00"`. */
  userCashbackPct: string;
}

export interface TopCashbackMerchantsResponse {
  merchants: TopCashbackMerchantEntry[];
}

export async function topCashbackMerchantsHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '10', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 10 : parsedLimit, 1), 50);

  try {
    // Overshoot the fetch so we can still return `limit` rows after
    // dropping entries whose merchant is absent from the catalog.
    // Factor of 4 covers the rare case where upstream has churned
    // a handful of top-cashback rows; hard-capped so an empty
    // catalog doesn't force us to scan thousands.
    const fetchLimit = Math.min(limit * 4, 200);
    const rows = await db
      .select()
      .from(merchantCashbackConfigs)
      .where(
        and(
          eq(merchantCashbackConfigs.active, true),
          gt(merchantCashbackConfigs.userCashbackPct, '0'),
        ),
      )
      .orderBy(desc(merchantCashbackConfigs.userCashbackPct))
      .limit(fetchLimit);

    const { merchantsById } = getMerchants();
    const merchants: TopCashbackMerchantEntry[] = [];
    for (const row of rows) {
      const merchant = merchantsById.get(row.merchantId);
      if (merchant === undefined) continue;
      const entry: TopCashbackMerchantEntry = {
        merchantId: row.merchantId,
        merchantName: merchant.name,
        userCashbackPct: row.userCashbackPct,
      };
      if (merchant.logoUrl !== undefined) entry.logoUrl = merchant.logoUrl;
      merchants.push(entry);
      if (merchants.length >= limit) break;
    }

    // 5-minute public cache — configs change rarely, and when they do
    // the admin panel invalidates on write (no ETag plumbing needed
    // for a marketing surface).
    c.header('Cache-Control', 'public, max-age=300');
    return c.json<TopCashbackMerchantsResponse>({ merchants });
  } catch (err) {
    log.error({ err }, 'Public top-cashback-merchants query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load cashback merchants' }, 500);
  }
}
