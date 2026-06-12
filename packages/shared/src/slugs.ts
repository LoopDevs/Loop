import type { Merchant } from './merchants.js';

/**
 * Country-agnostic brand slug: lowercases, spaces→hyphens, strips
 * everything outside `[a-z0-9-]`. This is the brand key — `"adidas"`,
 * `"home-depot"`, `"7-eleven"` — with no country dimension.
 *
 * Used by ADR 032 brand grouping (`/brand/:slug`), where every regional
 * variant of a brand must collapse to ONE group key, so `adidas` in CA,
 * US, and GB all resolve to the same brand tile. Do NOT use this for a
 * per-merchant link — two merchants of the same brand in different
 * countries share this slug and would collide.
 *
 * Matches the Go reference on upstream CTX: characters outside `[a-z0-9-]`
 * are dropped, not transliterated; no leading/trailing trim (whitespace
 * becomes a leading/trailing hyphen). Both behaviours are pinned by tests.
 */
export function brandSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** The minimal merchant shape `merchantSlug` reads. Accepting a subset
 * (rather than the full `Merchant`) lets backend public handlers that
 * only carry `{ name, country, slug }` call it without materialising a
 * whole merchant. */
export type SluggableMerchant = Pick<Merchant, 'name'> &
  Partial<Pick<Merchant, 'country' | 'slug'>>;

/**
 * Country-aware, per-merchant URL slug — the single source of truth for
 * slug generation shared by the backend slug index and every frontend
 * link. Unique per (brand, country) so regional variants of a brand never
 * collide in the `merchantsBySlug` index.
 *
 * Resolution order (single source of truth = CTX):
 *   1. **Prefer CTX's `slug`** when present. CTX owns the merchant's
 *      country and regenerates its own brand-country slug (e.g. `adidas-ca`),
 *      so we defer to it verbatim (lowercased + sanitised through
 *      `brandSlug` for URL safety, since CTX slugs are already in that form).
 *   2. **Derive `brandSlug(name)-<country>`** when CTX gives us a country
 *      but no slug. `"adidas"` + `CA` → `adidas-ca`.
 *   3. **Fall back to bare `brandSlug(name)`** when neither a CTX slug nor a
 *      country is available — a data-gap fallback that preserves the
 *      pre-country slug for untagged merchants (never worse than today).
 *
 * Transitional behaviour (CTX country-token rename rollout):
 *   - Un-renamed `"adidas Canada"` tagged `CA` (no CTX slug) → `adidas-canada-ca`.
 *     Unique, ugly-but-safe; resolves while the rename is mid-flight.
 *   - Renamed `"adidas"` tagged `CA` → `adidas-ca`. Clean, and matches CTX's
 *     own slug if it sends one.
 *   - Either way: never a bare `adidas` collision across CA / US / GB.
 *
 * Accepts either a merchant-like object or a bare string. The string form
 * is country-agnostic (equivalent to `brandSlug`) and exists only for the
 * few call sites that have a name but no merchant record (e.g. a map popup).
 */
export function merchantSlug(merchant: SluggableMerchant | string): string {
  if (typeof merchant === 'string') {
    return brandSlug(merchant);
  }

  // 1. CTX-provided slug wins — it already encodes brand + country.
  if (merchant.slug !== undefined && merchant.slug.trim() !== '') {
    const fromCtx = brandSlug(merchant.slug);
    if (fromCtx !== '') return fromCtx;
  }

  const base = brandSlug(merchant.name);

  // 2. Derive brand-country when we have a country to disambiguate by.
  const country = merchant.country?.trim();
  if (country) {
    const cc = brandSlug(country);
    if (cc !== '') return base === '' ? cc : `${base}-${cc}`;
  }

  // 3. Data-gap fallback: bare brand slug (pre-country behaviour).
  return base;
}
