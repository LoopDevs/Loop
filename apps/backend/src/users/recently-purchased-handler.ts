/**
 * `GET /api/users/me/recently-purchased` — distinct merchants the
 * caller has bought from, most-recent first.
 *
 * Sister surface to `/api/users/me/favorites` and intended for the
 * same home-page strip pattern (returning user lands on what they
 * already buy). Where favourites are pinned manually, this list is
 * derived from the orders ledger.
 *
 * "Purchased" here is `state IN ('paid', 'procuring', 'fulfilled')`:
 *   - `paid` / `procuring` are committed purchases the user has
 *     spent money on, even if the gift card hasn't dropped yet.
 *   - `fulfilled` is the clearly-completed case.
 *   - `pending_payment` / `failed` / `expired` are excluded — the
 *     user either hasn't paid or the order didn't go through, so
 *     the merchant isn't a useful repeat-purchase shortcut.
 *
 * GROUP BY `merchant_id` collapses multiple buys from the same
 * merchant into one chip ordered by their MAX(created_at). Limit
 * is 8 by default (clamped to [1, 20]) — enough to fill a 2x4 row
 * on mobile / a 4-up strip on desktop without crowding the home
 * grid below.
 */
import type { Context } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Merchant } from '@loop/shared';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';
import { resolveCallingUser } from './handler.js';

const log = logger.child({ handler: 'user-recently-purchased' });

const DEFAULT_LIMIT = 8;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;

const PURCHASED_STATES = ['paid', 'procuring', 'fulfilled'] as const;

export interface RecentlyPurchasedMerchantView {
  merchantId: string;
  /**
   * ISO-8601, the user's most recent order with this merchant. Drives
   * client-side ordering when it needs to merge with another stream.
   */
  lastPurchasedAt: string;
  /** Total purchased orders this user has with this merchant (count of qualifying rows). */
  orderCount: number;
  /**
   * Catalog row at read-time. Null when the merchant is temporarily
   * evicted from the in-memory catalog (ADR 021); the strip filters
   * those out so a stale id never crashes the render path.
   */
  merchant: Merchant | null;
}

export interface RecentlyPurchasedResponse {
  merchants: RecentlyPurchasedMerchantView[];
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_LIMIT;
  if (n < MIN_LIMIT) return MIN_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

export async function listRecentlyPurchasedHandler(c: Context): Promise<Response> {
  const user = await resolveCallingUser(c).catch((err: unknown) => {
    log.error({ err }, 'Failed to resolve calling user');
    return null;
  });
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const limit = parseLimit(c.req.query('limit'));

  // GROUP BY merchant_id with MAX(created_at) gives one row per
  // distinct merchant ordered by most-recent qualifying order. The
  // `orders_user_created` btree on (user_id, created_at) covers the
  // WHERE + ORDER BY; the partial-index hot-paths under
  // `orders_pending_payment` / `orders_fulfilled_*` aren't relevant
  // here — we want the broader purchased-states cut.
  const rows = await db
    .select({
      merchantId: orders.merchantId,
      lastPurchasedAt: sql<Date>`MAX(${orders.createdAt})`.as('last_purchased_at'),
      orderCount: sql<string>`count(*)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, user.id),
        inArray(orders.state, PURCHASED_STATES as unknown as string[]),
      ),
    )
    .groupBy(orders.merchantId)
    .orderBy(desc(sql`MAX(${orders.createdAt})`))
    .limit(limit);

  const { merchantsById } = getMerchants();
  const merchants: RecentlyPurchasedMerchantView[] = rows.map((row) => ({
    merchantId: row.merchantId,
    lastPurchasedAt:
      row.lastPurchasedAt instanceof Date
        ? row.lastPurchasedAt.toISOString()
        : new Date(row.lastPurchasedAt).toISOString(),
    orderCount: Number(row.orderCount),
    merchant: merchantsById.get(row.merchantId) ?? null,
  }));

  return c.json<RecentlyPurchasedResponse>({ merchants });
}
