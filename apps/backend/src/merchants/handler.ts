import type { Context } from 'hono';
import { getMerchants } from './sync.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Defensive cap on the search input. Merchant names are short and this keeps
// a pathological `q` string (e.g. from a fuzzer) from running includes()
// against an unbounded pattern.
const MAX_QUERY_LENGTH = 100;

/**
 * GET /api/merchants
 *
 * Query params: page, limit, q (search)
 */
export function merchantListHandler(c: Context): Response {
  const { merchants } = getMerchants();

  const q = (c.req.query('q') ?? '').toLowerCase().trim().slice(0, MAX_QUERY_LENGTH);
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      parseInt(c.req.query('limit') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE,
    ),
  );

  const filtered = q ? merchants.filter((m) => m.name.toLowerCase().includes(q)) : merchants;

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
 * GET /api/merchants/by-slug/:slug
 *
 * O(1) slug lookup — preferred over fetching all merchants client-side.
 * Slug mirrors the frontend encodeUrlName: lowercase, spaces→hyphens, strip non-alphanumeric.
 */
export function merchantBySlugHandler(c: Context): Response {
  const slug = c.req.param('slug') ?? '';
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
