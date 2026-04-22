/**
 * Public top-cashback-merchants endpoint (ADR 011 / 020).
 *
 * `GET /api/public/top-cashback-merchants` — unauthenticated,
 * CDN-friendly list of the N merchants with the highest active
 * `user_cashback_pct`. Marketing uses this on the landing page to
 * render the "best cashback" band — "Earn up to X% at Argos, Amazon,
 * Tesco...".
 *
 * Joins the active `merchant_cashback_configs` pct against the
 * in-memory merchant catalog for name / logo enrichment. Merchants
 * that have been evicted from the catalog (ADR 021 Rule B) are
 * dropped from the response — we don't want the marketing list
 * pointing at a merchant that's about to disappear.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500. DB throws fall through to a last-known-good
 *     snapshot; first-boot fallback is an empty list.
 *   - `Cache-Control: public, max-age=300` on the happy path,
 *     `max-age=60` on the fallback path.
 */
import type { Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-top-cashback-merchants' });

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface TopCashbackMerchant {
  id: string;
  name: string;
  logoUrl: string | null;
  /** numeric(5,2) as string, e.g. `"15.00"`. */
  userCashbackPct: string;
}

export interface PublicTopCashbackMerchantsResponse {
  merchants: TopCashbackMerchant[];
  asOf: string;
}

interface ConfigRow {
  merchantId: string;
  userCashbackPct: string;
}

let lastKnownGood: PublicTopCashbackMerchantsResponse | null = null;

/** Test-only reset. */
export function __resetPublicTopCashbackMerchantsCache(): void {
  lastKnownGood = null;
}

async function compute(limit: number): Promise<PublicTopCashbackMerchantsResponse> {
  const rows = (await db
    .select({
      merchantId: merchantCashbackConfigs.merchantId,
      userCashbackPct: merchantCashbackConfigs.userCashbackPct,
    })
    .from(merchantCashbackConfigs)
    .where(eq(merchantCashbackConfigs.active, true))
    .orderBy(desc(merchantCashbackConfigs.userCashbackPct))) as ConfigRow[];

  const { merchantsById } = getMerchants();

  // Drop merchants evicted from the catalog (ADR 021 Rule B) — a
  // config row with no matching merchant is a stale pointer we
  // shouldn't surface to unauth'd visitors.
  const merchants: TopCashbackMerchant[] = [];
  for (const row of rows) {
    const m = merchantsById.get(row.merchantId);
    if (m === undefined) continue;
    merchants.push({
      id: m.id,
      name: m.name,
      logoUrl: m.logoUrl ?? null,
      userCashbackPct: row.userCashbackPct,
    });
    if (merchants.length >= limit) break;
  }

  return { merchants, asOf: new Date().toISOString() };
}

export async function publicTopCashbackMerchantsHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(
    Math.max(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, 1),
    MAX_LIMIT,
  );

  try {
    const snapshot = await compute(limit);
    lastKnownGood = snapshot;
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicTopCashbackMerchantsResponse>(snapshot);
  } catch (err) {
    log.error({ err }, 'Public top-cashback-merchants computation failed — serving fallback');
    c.header('cache-control', 'public, max-age=60');
    if (lastKnownGood !== null) {
      return c.json<PublicTopCashbackMerchantsResponse>(lastKnownGood);
    }
    return c.json<PublicTopCashbackMerchantsResponse>({
      merchants: [],
      asOf: new Date().toISOString(),
    });
  }
}
