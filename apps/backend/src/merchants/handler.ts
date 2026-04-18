import type { Context } from 'hono';
import { getMerchants } from './sync.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Defensive cap on the search input. Merchant names are short and this keeps
// a pathological `q` string (e.g. from a fuzzer) from running includes()
// against an unbounded pattern.
const MAX_QUERY_LENGTH = 100;

/**
 * Lowercase + strip diacritics so `q=cafe` matches merchant `Café`, and so a
 * user searching `Dunkin'` matches `Dunkin'` regardless of smart quotes
 * vs straight apostrophes. Canonicalizes to NFD (decomposes accented chars
 * into base + combining mark) then removes the combining-diacritic block
 * (U+0300–U+036F). ASCII input passes through untouched.
 */
function foldForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * GET /api/merchants
 *
 * Query params: page, limit, q (search)
 */
export function merchantListHandler(c: Context): Response {
  const { merchants } = getMerchants();

  const q = foldForSearch((c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH));
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      parseInt(c.req.query('limit') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE,
    ),
  );

  const filtered = q ? merchants.filter((m) => foldForSearch(m.name).includes(q)) : merchants;

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paginated = filtered.slice(start, start + limit);

  c.header('Cache-Control', 'public, max-age=300'); // 5 minute cache
  return c.json({
    merchants: paginated,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  });
}

/**
 * GET /api/merchants/all
 *
 * Returns the entire enabled merchant catalog in a single response.
 * Audit A-002: `/api/merchants` hard-caps at 100 items per page, which
 * silently truncated UI surfaces (home, map, navbar search) that need the
 * full catalog. This endpoint serves them directly, avoiding the need for
 * the client to page through. Response shape is `{ merchants: Merchant[] }`
 * — no pagination envelope, since the whole point is to skip paging.
 *
 * The catalog is already in memory (`getMerchants()`) so this is O(N) over
 * the cached slice and costs no upstream call. 5-minute public cache
 * matches the per-page endpoint.
 */
export function merchantAllHandler(c: Context): Response {
  const { merchants } = getMerchants();
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ merchants, total: merchants.length });
}

/**
 * GET /api/merchants/by-slug/:slug
 *
 * O(1) slug lookup — preferred over fetching all merchants client-side.
 * Slug mirrors the frontend encodeUrlName: lowercase, spaces→hyphens, strip non-alphanumeric.
 */
export function merchantBySlugHandler(c: Context): Response {
  // Slugs in the index are always lowercase (see merchantSlug in @loop/shared).
  // Accept a case-insensitive match so a hand-typed URL like `/by-slug/Target`
  // still resolves instead of 404'ing.
  const slug = (c.req.param('slug') ?? '').toLowerCase();
  const { merchantsBySlug } = getMerchants();

  const merchant = merchantsBySlug.get(slug);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  c.header('Cache-Control', 'public, max-age=300'); // 5 minute cache
  return c.json({ merchant });
}

/**
 * GET /api/merchants/:id
 */
export function merchantDetailHandler(c: Context): Response {
  const id = c.req.param('id') ?? '';
  const { merchantsById } = getMerchants();

  const merchant = merchantsById.get(id);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  c.header('Cache-Control', 'public, max-age=300'); // 5 minute cache
  return c.json({ merchant });
}
