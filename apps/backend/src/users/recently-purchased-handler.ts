// GET /api/users/me/recently-purchased — distinct merchants, most-recent first — ADR 019
import type { Context } from 'hono';
import type { RecentlyPurchasedMerchantView, RecentlyPurchasedResponse } from '@loop/shared';
import { db } from '../db/client.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';
import { resolveCallingUser } from './handler.js';

const log = logger.child({ handler: 'user-recently-purchased' });

const DEFAULT_LIMIT = 8;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;

const PURCHASED_STATES = ['paid', 'fulfilled'] as const;

export type { RecentlyPurchasedMerchantView, RecentlyPurchasedResponse };

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

  const qualifying = await db
    .collection('orders')
    .findMany({ userId: user.id, state: { $in: [...PURCHASED_STATES] } });
  const byMerchant = new Map<string, { lastPurchasedAt: Date; orderCount: number }>();
  for (const order of qualifying) {
    const entry = byMerchant.get(order.merchantId);
    if (entry === undefined) {
      byMerchant.set(order.merchantId, { lastPurchasedAt: order.createdAt, orderCount: 1 });
    } else {
      entry.orderCount++;
      if (order.createdAt > entry.lastPurchasedAt) entry.lastPurchasedAt = order.createdAt;
    }
  }
  const rows = [...byMerchant.entries()]
    .map(([merchantId, agg]) => ({
      merchantId,
      lastPurchasedAt: agg.lastPurchasedAt,
      orderCount: String(agg.orderCount),
    }))
    .sort((a, b) => b.lastPurchasedAt.getTime() - a.lastPurchasedAt.getTime())
    .slice(0, limit);

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
