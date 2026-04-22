/**
 * Admin global config-history feed (ADR 011 / 018).
 *
 * `GET /api/admin/merchant-cashback-configs/history` — newest-first
 * view of every cashback-config edit across every merchant. Companion
 * to `/merchant-cashback-configs/:merchantId/history` which scopes to
 * one merchant.
 *
 * Drives a "Recent config changes" strip on the admin dashboard — ops
 * can see "the last 20 things anyone changed" without picking a
 * merchant first.
 *
 * URL depth: `/history` (one segment after `configs`) doesn't collide
 * with `/:merchantId/history` (two segments) — the hono router matches
 * the literal segment first.
 *
 * Merchant-name enrichment: the catalog in-memory store is the source
 * of truth for display names. Catalog-evicted merchants fall back to
 * `merchantId` per ADR 021 Rule A — the admin surface is the one place
 * we don't drop the row.
 *
 * `?limit=` default 50, clamp [1, 200]. Wider ceiling than the
 * per-merchant history (50) because this is the fleet-wide view —
 * a month of edits for a small config table comfortably fits.
 */
import type { Context } from 'hono';
import { desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigHistory } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-configs-history' });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AdminConfigHistoryEntry {
  id: string;
  merchantId: string;
  /** Display name from the catalog; falls back to merchantId. */
  merchantName: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: string;
}

export interface AdminConfigHistoryResponse {
  history: AdminConfigHistoryEntry[];
}

interface DbRow {
  id: string;
  merchantId: string;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
  changedBy: string;
  changedAt: Date;
}

export async function adminConfigsHistoryHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const rows = (await db
      .select()
      .from(merchantCashbackConfigHistory)
      .orderBy(desc(merchantCashbackConfigHistory.changedAt))
      .limit(limit)) as DbRow[];

    const { merchantsById } = getMerchants();

    const history: AdminConfigHistoryEntry[] = rows.map((r) => ({
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

    return c.json<AdminConfigHistoryResponse>({ history });
  } catch (err) {
    log.error({ err }, 'Admin global config-history query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to read config history' }, 500);
  }
}
