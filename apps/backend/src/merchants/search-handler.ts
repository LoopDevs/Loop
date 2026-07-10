import type { Context } from 'hono';
import type { Merchant } from '@loop/shared';
import { foldForSearch, merchantInCountry } from '@loop/shared';
import { getMerchants } from './sync.js';
import { toLiteMerchant } from './lite.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// Mirrors merchantListHandler's defensive cap on q — keeps a pathological
// query string from running an unbounded-cost includes() scan.
const MAX_QUERY_LENGTH = 100;

function bySavings(a: Merchant, b: Merchant): number {
  return (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0);
}

/**
 * GET /api/merchants/search
 *
 * Server-side merchant name search (go-live-plan §P3 / readiness-backlog
 * S4-7 §3 tail). Replaces the client-side pattern the Navbar dropdown and
 * MobileHome search used to run — fetch the *entire* catalog via
 * `/api/merchants/all` and filter it in the browser on every keystroke —
 * with the same match computed here over the in-memory catalog instead.
 * The catalog is memory-backed (synced from upstream CTX, see
 * `merchants/sync.ts`), not Postgres, so this is a plain array filter —
 * no SQL, no injection surface.
 *
 * Match semantics are intentionally identical to the pre-existing filters
 * so switching a caller from client-side to server-side doesn't change
 * what the user sees:
 *  - `foldForSearch(m.name).includes(q)` — same accent/case-insensitive
 *    substring match on name as `/api/merchants?q=` and the Navbar/
 *    MobileHome client filters.
 *  - `enabled !== false` — same as the client filters (the base catalog
 *    already excludes disabled merchants in production; this only bites
 *    under the dev-only `INCLUDE_DISABLED_MERCHANTS` override).
 *
 * Query params:
 *  - `q`: search text. Empty/missing returns an empty result rather than
 *    the full catalog — this endpoint is a search, not another catalog
 *    dump.
 *  - `country`: optional ISO 3166-1 alpha-2 code (ADR 034). Search spans
 *    every country; when supplied, in-country matches rank first —
 *    mirrors the existing Navbar/MobileHome UX. Never used to filter
 *    results out.
 *  - `limit`: bounded result count, default 20, max 50. This endpoint is
 *    for interactive typeahead (Navbar dropdown) or a search-result grid
 *    (MobileHome), not a full-catalog export — the 20-50 range comfortably
 *    covers both after client-side ADR-032 brand grouping.
 *
 * Response is the lite merchant projection (S4-7's `fields=lite` — no
 * description/instructions/terms), matching `/api/merchants/all?fields=lite`.
 * `total` is the full match count before `limit` truncation.
 */
export function merchantSearchHandler(c: Context): Response {
  const { merchants } = getMerchants();

  const q = foldForSearch((c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH));
  const countryRaw = (c.req.query('country') ?? '').trim();
  const country = countryRaw.length > 0 ? countryRaw.slice(0, 2).toUpperCase() : undefined;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(c.req.query('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  // Cache-Control mirrors the sibling merchant reads (`/api/merchants`,
  // `/api/merchants/all`): 5-minute public cache. The catalog syncs on a
  // multi-hour cadence, so brief staleness is fine, and since the cache key
  // is the full URL (including `q`), this doesn't collide across distinct
  // searches — it just lets a repeated identical search within the window
  // skip origin.
  c.header('Cache-Control', 'public, max-age=300');

  if (q.length === 0) {
    return c.json({ merchants: [], total: 0 });
  }

  const matched = merchants.filter((m) => m.enabled !== false && foldForSearch(m.name).includes(q));

  const ordered =
    country !== undefined
      ? matched.slice().sort((a, b) => {
          const rank =
            (merchantInCountry(b, country) ? 1 : 0) - (merchantInCountry(a, country) ? 1 : 0);
          return rank !== 0 ? rank : bySavings(a, b);
        })
      : matched.slice().sort(bySavings);

  return c.json({
    merchants: ordered.slice(0, limit).map(toLiteMerchant),
    total: matched.length,
  });
}
