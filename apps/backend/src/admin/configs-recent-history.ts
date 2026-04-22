/**
 * Admin global cashback-config history feed (ADR 011 / 019 Tier 2).
 *
 * `GET /api/admin/merchant-cashback-configs/history` — newest-first
 * view of every cashback-config edit across every merchant, so an
 * admin can answer "what changed recently?" without picking a
 * merchant first. Pairs with the per-merchant
 * `/:merchantId/history` endpoint (unchanged) — that's for drilling
 * into one merchant's timeline.
 *
 * Merchant name comes from the in-memory catalog with a fallback to
 * `merchantId` (admin-surface convention — support can still read
 * raw ids).
 */
import type { Context } from 'hono';
import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigHistory } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-configs-recent-history' });

export interface AdminConfigHistoryRow {
  id: string;
  merchantId: string;
  merchantName: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

export interface AdminConfigsRecentHistoryResponse {
  history: AdminConfigHistoryRow[];
}

export async function adminConfigsRecentHistoryHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '50', 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200);

  try {
    const rows = await db
      .select()
      .from(merchantCashbackConfigHistory)
      .orderBy(desc(merchantCashbackConfigHistory.changedAt))
      .limit(limit);

    const { merchantsById } = getMerchants();
    const history: AdminConfigHistoryRow[] = rows.map((r) => ({
      id: r.id,
      merchantId: r.merchantId,
      merchantName: merchantsById.get(r.merchantId)?.name ?? r.merchantId,
      wholesalePct: r.wholesalePct,
      userCashbackPct: r.userCashbackPct,
      loopMarginPct: r.loopMarginPct,
      active: r.active,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
    }));

    return c.json<AdminConfigsRecentHistoryResponse>({ history });
  } catch (err) {
    log.error({ err }, 'Admin configs-recent-history query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load recent config history' }, 500);
  }
}
