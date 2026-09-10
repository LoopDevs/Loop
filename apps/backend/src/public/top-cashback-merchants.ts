// Public top-cashback-merchants endpoint — ADR 011, ADR 020
import type { Context } from 'hono';
// Response shape lives in `@loop/shared` alongside the web's consumer (ADR 019 single-source rule). Re-exported below for existing backend callers that import the symbol relative to this module.
import type { PublicTopCashbackMerchantsResponse, TopCashbackMerchant } from '@loop/shared';
import { isSupportedCountryCode, merchantInCountry, merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
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

// CAT-02 (2026-06-30 cold audit): keyed by `${limit}:${country ?? ''}` so a fallback snapshot never crosses country boundaries — a US visitor hitting the fallback path must never see a cached AE-scoped result and vice versa.
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
  const configs = await db
    .collection('merchant_cashback_configs')
    .findMany({ active: true }, { sort: [['userCashbackPct', 'desc']] });
  const rows: ConfigRow[] = configs.map((cfg) => ({
    merchantId: cfg.merchantId,
    userCashbackPct: cfg.userCashbackPct.toFixed(2),
  }));

  const { merchantsById } = getMerchants();

  // Drop merchants evicted from the catalog (ADR 021 Rule B) — a config row with no matching merchant is a stale pointer we shouldn't surface to unauth'd visitors.
  const merchants: TopCashbackMerchant[] = [];
  for (const row of rows) {
    const m = merchantsById.get(row.merchantId);
    if (m === undefined) continue;
    // CAT-02: same country↔merchant visibility rule home.tsx / the now-fixed brand.$slug.tsx already use — a merchant tagged to a different country/currency than the visitor's shouldn't feed the "best cashback" marketing band for them.
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

  // CAT-02: optional `?country=` filter. Lenient parsing matching this handler's own `limit` precedent (and the rest of the public surface, ADR 020) — an unrecognised code is treated as "no filter" rather than a 400, since this is an unauthenticated, CDN-cached, never-500 marketing endpoint that should degrade gracefully for any caller.
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
