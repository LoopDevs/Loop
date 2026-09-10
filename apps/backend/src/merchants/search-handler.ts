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

// Server-side merchant name search — S4-7 §3
export function merchantSearchHandler(c: Context): Response {
  const { merchants } = getMerchants();

  const q = foldForSearch((c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH));
  const countryRaw = (c.req.query('country') ?? '').trim();
  const country = countryRaw.length > 0 ? countryRaw.slice(0, 2).toUpperCase() : undefined;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(c.req.query('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  // No HTTP caching — catalog reads serve the live ws-maintained
  // in-memory store; a cache in front of it only delays edits.
  c.header('Cache-Control', 'no-store');

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
