// public per-merchant detail endpoint — ADR 011, ADR 020
import type { Context } from 'hono';
import type { PublicMerchantDetail } from '@loop/shared';
import { isSupportedCountryCode, merchantInCountry, merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-merchant' });

const MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const MERCHANT_ID_MAX = 128;

const lastKnownGood = new Map<string, PublicMerchantDetail>();

/** Test-only reset. */
export function __resetPublicMerchantCache(): void {
  lastKnownGood.clear();
}

interface ResolvedMerchant {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

// CAT-02: country filter prevents revealing out-of-scope merchants, matching brand.$slug.tsx
function resolveMerchant(idOrSlug: string, country: string | null): ResolvedMerchant | null {
  const { merchantsById, merchantsBySlug } = getMerchants();
  const m = merchantsById.get(idOrSlug) ?? merchantsBySlug.get(idOrSlug);
  if (m === undefined) return null;
  if (country !== null && !merchantInCountry(m, country)) return null;
  return { id: m.id, name: m.name, slug: merchantSlug(m), logoUrl: m.logoUrl ?? null };
}

async function compute(resolved: ResolvedMerchant): Promise<PublicMerchantDetail> {
  const config = await db
    .collection('merchant_cashback_configs')
    .findOne({ merchantId: resolved.id, active: true });

  return {
    id: resolved.id,
    name: resolved.name,
    slug: resolved.slug,
    logoUrl: resolved.logoUrl,
    userCashbackPct: config !== null ? config.userCashbackPct.toFixed(2) : null,
    asOf: new Date().toISOString(),
  };
}

export async function publicMerchantHandler(c: Context): Promise<Response> {
  const idParam = c.req.param('id');
  if (idParam === undefined || idParam.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }
  if (idParam.length > MERCHANT_ID_MAX || !MERCHANT_ID_RE.test(idParam)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is malformed' }, 400);
  }

  // CAT-02: lenient country parsing (unrecognised code → no filter) per ADR 020
  const countryRaw = c.req.query('country');
  const country =
    countryRaw !== undefined && isSupportedCountryCode(countryRaw)
      ? countryRaw.toUpperCase()
      : null;

  const resolved = resolveMerchant(idParam, country);
  if (resolved === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  try {
    const snapshot = await compute(resolved);
    lastKnownGood.set(resolved.id, snapshot);
    c.header('cache-control', 'public, max-age=300');
    return c.json<PublicMerchantDetail>(snapshot);
  } catch (err) {
    log.error(
      { err, merchantId: resolved.id },
      'Public merchant detail computation failed — serving fallback',
    );
    c.header('cache-control', 'public, max-age=60');
    const fallback = lastKnownGood.get(resolved.id);
    if (fallback !== undefined) {
      return c.json<PublicMerchantDetail>(fallback);
    }
    return c.json<PublicMerchantDetail>({
      id: resolved.id,
      name: resolved.name,
      slug: resolved.slug,
      logoUrl: resolved.logoUrl,
      userCashbackPct: null,
      asOf: new Date().toISOString(),
    });
  }
}
