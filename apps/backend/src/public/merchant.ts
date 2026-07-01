/**
 * Public per-merchant detail endpoint (ADR 011 / 020).
 *
 * `GET /api/public/merchants/:id` — unauthenticated single-merchant
 * view for SEO landing pages (e.g. `/cashback/amazon-us`). Backs
 * the marketing pitch for one merchant — "earn 5.5% cashback at
 * Amazon" — with a narrow, PII-free payload that sits behind a
 * CDN.
 *
 * Resolves the merchant via the in-memory catalog (id OR slug,
 * so /cashback/<slug> SSR pages can pass the slug directly
 * without a second catalog lookup) and joins the active
 * merchant_cashback_configs.user_cashback_pct. A merchant with
 * no active config returns `userCashbackPct: null` — the "coming
 * soon" SEO state rather than 404, so the landing page can
 * render before commercial terms are finalised.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500 — DB trouble → serve a last-known-good cached
 *     snapshot per merchantId; first-miss bootstrap → serve the
 *     catalog row with a null pct. SEO crawlers get a clean
 *     signal either way.
 *   - 404 only for unknown merchantId (evicted / typo slug).
 *     Keeps SEO crawlers' broken-link reports meaningful.
 *   - `Cache-Control: public, max-age=300` on the happy path,
 *     `max-age=60` on the fallback path.
 *   - No commercial-terms fields (wholesale/margin). Only the
 *     user-facing pct a visitor sees.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { PublicMerchantDetail } from '@loop/shared';
import { isSupportedCountryCode, merchantInCountry, merchantSlug } from '@loop/shared';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
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

interface ConfigRow {
  userCashbackPct: string;
}

/**
 * Resolved merchant for the public detail view. Carries `slug` — the
 * country-aware {@link merchantSlug} computed from the full catalog row
 * (CTX slug, else brand+country) — so the SEO landing page emits a URL
 * that round-trips through the country-aware `merchantsBySlug` index.
 */
interface ResolvedMerchant {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/**
 * CAT-02 (2026-06-30 cold audit): `country` applies the same
 * country↔merchant visibility rule `home.tsx` / `brand.$slug.tsx`
 * already use — resolving to `null` (404 at the handler) for a
 * merchant tagged to a different country/currency than the caller's,
 * so `/cashback/:slug` can't reveal a merchant that's out of scope
 * for the visitor's locale, matching brand.$slug.tsx's existing
 * filter-then-find pattern instead of resolving unconditionally.
 */
function resolveMerchant(idOrSlug: string, country: string | null): ResolvedMerchant | null {
  const { merchantsById, merchantsBySlug } = getMerchants();
  const m = merchantsById.get(idOrSlug) ?? merchantsBySlug.get(idOrSlug);
  if (m === undefined) return null;
  if (country !== null && !merchantInCountry(m, country)) return null;
  return { id: m.id, name: m.name, slug: merchantSlug(m), logoUrl: m.logoUrl ?? null };
}

async function compute(resolved: ResolvedMerchant): Promise<PublicMerchantDetail> {
  // Active config is 0 or 1 row per merchantId.
  const rows = (await db
    .select({ userCashbackPct: merchantCashbackConfigs.userCashbackPct })
    .from(merchantCashbackConfigs)
    .where(
      and(
        eq(merchantCashbackConfigs.merchantId, resolved.id),
        eq(merchantCashbackConfigs.active, true),
      ),
    )
    .limit(1)) as ConfigRow[];

  return {
    id: resolved.id,
    name: resolved.name,
    slug: resolved.slug,
    logoUrl: resolved.logoUrl,
    userCashbackPct: rows[0]?.userCashbackPct ?? null,
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

  // CAT-02: optional `?country=` filter. Lenient parsing (unrecognised
  // code → no filter) matching top-cashback-merchants.ts and the rest
  // of the public surface's precedent (ADR 020) — never 400 a visitor
  // over a malformed locale hint.
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
    // First-miss bootstrap fallback: catalog row + null pct.
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
