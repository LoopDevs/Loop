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
import { desc, eq, sql } from 'drizzle-orm';
// Response shape lives in `@loop/shared` alongside the web's consumer
// (ADR 019 single-source rule). Re-exported below for existing backend
// callers that import the symbol relative to this module.
import type { PublicTopCashbackMerchantsResponse, TopCashbackMerchant } from '@loop/shared';
import { isSupportedCountryCode, merchantInCountry, merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

export type { PublicTopCashbackMerchantsResponse, TopCashbackMerchant };

const log = logger.child({ handler: 'public-top-cashback-merchants' });

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface ConfigRow {
  merchantId: string;
  userCashbackPct: string;
}

// CAT-02 (2026-06-30 cold audit): keyed by `${limit}:${country ?? ''}` so a
// fallback snapshot never crosses country boundaries — a US visitor hitting
// the fallback path must never see a cached AE-scoped result and vice versa.
const lastKnownGoodByKey = new Map<string, PublicTopCashbackMerchantsResponse>();

function cacheKey(limit: number, country: string | null): string {
  return `${limit}:${country ?? ''}`;
}

/** Test-only reset. */
export function __resetPublicTopCashbackMerchantsCache(): void {
  lastKnownGoodByKey.clear();
}

async function compute(
  limit: number,
  country: string | null,
): Promise<PublicTopCashbackMerchantsResponse> {
  const rows = (await db
    .select({
      merchantId: merchantCashbackConfigs.merchantId,
      userCashbackPct: merchantCashbackConfigs.userCashbackPct,
    })
    .from(merchantCashbackConfigs)
    .where(eq(merchantCashbackConfigs.active, true))
    // Drizzle surfaces `user_cashback_pct` as a string; sort on an
    // explicit numeric cast so the ordering can never degrade to
    // lexicographic ("9.50" ranking above "10.00") regardless of how
    // the column is typed at the SQL layer.
    .orderBy(desc(sql`${merchantCashbackConfigs.userCashbackPct}::numeric`))) as ConfigRow[];

  const { merchantsById } = getMerchants();

  // Drop merchants evicted from the catalog (ADR 021 Rule B) — a
  // config row with no matching merchant is a stale pointer we
  // shouldn't surface to unauth'd visitors.
  const merchants: TopCashbackMerchant[] = [];
  for (const row of rows) {
    const m = merchantsById.get(row.merchantId);
    if (m === undefined) continue;
    // CAT-02: same country↔merchant visibility rule home.tsx / the now-
    // fixed brand.$slug.tsx already use — a merchant tagged to a
    // different country/currency than the visitor's shouldn't feed the
    // "best cashback" marketing band for them.
    if (country !== null && !merchantInCountry(m, country)) continue;
    merchants.push({
      id: m.id,
      name: m.name,
      slug: merchantSlug(m),
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

  // CAT-02: optional `?country=` filter. Lenient parsing matching this
  // handler's own `limit` precedent (and the rest of the public surface,
  // ADR 020) — an unrecognised code is treated as "no filter" rather than
  // a 400, since this is an unauthenticated, CDN-cached, never-500
  // marketing endpoint that should degrade gracefully for any caller.
  const countryRaw = c.req.query('country');
  const country =
    countryRaw !== undefined && isSupportedCountryCode(countryRaw)
      ? countryRaw.toUpperCase()
      : null;

  const key = cacheKey(limit, country);
  try {
    const snapshot = await compute(limit, country);
    lastKnownGoodByKey.set(key, snapshot);
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicTopCashbackMerchantsResponse>(snapshot);
  } catch (err) {
    log.error({ err }, 'Public top-cashback-merchants computation failed — serving fallback');
    c.header('cache-control', 'public, max-age=60');
    const fallback = lastKnownGoodByKey.get(key);
    if (fallback !== undefined) {
      return c.json<PublicTopCashbackMerchantsResponse>(fallback);
    }
    return c.json<PublicTopCashbackMerchantsResponse>({
      merchants: [],
      asOf: new Date().toISOString(),
    });
  }
}
