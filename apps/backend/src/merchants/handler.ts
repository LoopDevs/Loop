import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { foldForSearch } from '@loop/shared';
import { getMerchants } from './sync.js';
import { getUpstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'merchants' });

/**
 * Subset of CTX's `GET /merchants/:id` response we care about for
 * enriching the merchant detail. `.passthrough()` keeps anything we
 * don't know about so future CTX fields can be surfaced without a
 * schema bump.
 */
const UpstreamMerchantDetailResponse = z
  .object({
    info: z
      .object({
        description: z.string().optional(),
        longDescription: z.string().optional(),
        intro: z.string().optional(),
        instructions: z.string().optional(),
        terms: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

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
 * Slug format (lowercase, spaces→hyphens, strip non-alphanumeric) comes
 * from `merchantSlug()` in `@loop/shared/slugs.ts` — the single source
 * of truth shared with the frontend, so the backend index and frontend
 * links can't drift.
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
 *
 * Requires auth — we forward the user's bearer (+ X-Client-Id) to
 * CTX's `GET /merchants/:id` to pull the long-form content (info.
 * description, longDescription, terms, instructions) that the list
 * endpoint doesn't populate. The cached list-sync merchant is the
 * baseline; upstream info fields are merged over it.
 *
 * If the upstream call fails (network, shape drift, 404, timeout),
 * we fall back to the cached merchant rather than 502ing the page —
 * the user still sees the basics and we log the failure for
 * diagnosis.
 */
export async function merchantDetailHandler(c: Context): Promise<Response> {
  const id = c.req.param('id') ?? '';

  if (!/^[\w-]+$/.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid merchant ID' }, 400);
  }

  const { merchantsById } = getMerchants();
  const cached = merchantsById.get(id);
  if (cached === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  const merchant = { ...cached };

  try {
    const bearer = c.get('bearerToken') as string | undefined;
    const clientId = c.get('clientId') as string | undefined;
    const headers: Record<string, string> = {};
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    if (clientId) headers['X-Client-Id'] = clientId;

    const response = await getUpstreamCircuit('merchants').fetch(upstreamUrl(`/merchants/${id}`), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const raw = (await response.json().catch(() => null)) as unknown;
      const parsed = UpstreamMerchantDetailResponse.safeParse(raw);
      if (parsed.success && parsed.data.info) {
        const { description, longDescription, terms, instructions } = parsed.data.info;
        // longDescription wins when both are present — it's the
        // full-length body copy, while `description` is often just a
        // headline repeat. Fall back to `description` otherwise.
        if (longDescription) merchant.description = longDescription;
        else if (description) merchant.description = description;
        if (terms) merchant.terms = terms;
        if (instructions) merchant.instructions = instructions;
      }
    } else {
      log.warn(
        { id, status: response.status },
        'Upstream /merchants/:id returned non-OK — serving cached',
      );
    }
  } catch (err) {
    log.warn(
      { id, err: err instanceof Error ? err.message : String(err) },
      'Upstream /merchants/:id errored — serving cached',
    );
  }

  c.header('Cache-Control', 'private, max-age=300');
  return c.json({ merchant });
}

/**
 * `GET /api/merchants/cashback-rates` — public bulk map of
 * `{ merchantId → userCashbackPct }` for every active config
 * (ADR 011 / 015). Lets catalog / list / map views render a
 * cashback badge on each card without N+1-ing the per-merchant
 * endpoint. Merchants without an active config are omitted (the
 * client should treat a missing key as "no cashback" and hide the
 * badge). Values are `numeric(5,2)` strings, same as the per-
 * merchant endpoint.
 *
 * 5-minute public Cache-Control matches the merchant-catalog
 * endpoints — admin cashback edits are rare and the stale window
 * is acceptable.
 */
export async function merchantsCashbackRatesHandler(c: Context): Promise<Response> {
  const rows = await db
    .select({
      merchantId: merchantCashbackConfigs.merchantId,
      userCashbackPct: merchantCashbackConfigs.userCashbackPct,
    })
    .from(merchantCashbackConfigs)
    .where(eq(merchantCashbackConfigs.active, true));

  // Map-shaped response — the frontend converts to a `Map` once
  // and does O(1) lookups per merchant card. Plain object (not
  // a tuple array) so the JSON is human-readable in devtools.
  const rates: Record<string, string> = {};
  for (const row of rows) {
    rates[row.merchantId] = row.userCashbackPct;
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ rates });
}

/**
 * `GET /api/merchants/:merchantId/cashback-rate` — public surface
 * for rendering "Earn X% cashback" on the gift-card detail page
 * before checkout (ADR 011 / 015). Reads the active `user_cashback_pct`
 * from `merchant_cashback_configs`; when the merchant has no config
 * (admin hasn't configured it) or the config is inactive, returns
 * `{ userCashbackPct: null }` so the client can hide the badge rather
 * than show an implausible "0% cashback" message.
 *
 * The response is safe to cache publicly (5 min) — admins rarely
 * change cashback rates, and the stale window here is the same as
 * the merchant list endpoint.
 */
export async function merchantCashbackRateHandler(c: Context): Promise<Response> {
  const id = c.req.param('merchantId') ?? '';
  // Tight character class — matches the detail handler's input
  // validation. CTX merchant IDs are slug-shaped; anything else is a
  // scan attempt.
  if (!/^[\w-]+$/.test(id)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid merchant ID' }, 400);
  }

  // Merchant-catalog guard: keep the endpoint honest — a caller can't
  // enumerate configs for ids that don't correspond to a real merchant.
  const { merchantsById } = getMerchants();
  if (!merchantsById.has(id)) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  const row = await db.query.merchantCashbackConfigs.findFirst({
    where: and(
      eq(merchantCashbackConfigs.merchantId, id),
      eq(merchantCashbackConfigs.active, true),
    ),
  });

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    merchantId: id,
    userCashbackPct: row?.userCashbackPct ?? null,
  });
}
