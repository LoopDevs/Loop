import type { Context } from 'hono';
import { z } from 'zod';
import { foldForSearch } from '@loop/shared';
import { getMerchants } from './sync.js';
import { toLiteMerchant } from './lite.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/require-auth.js';
import { getUserCtxUserId } from '../db/users.js';
import { ctxActAsHeaders } from '../ctx/user-provisioning.js';

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

  c.header('Cache-Control', 'no-store');
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
 * the live slice and costs no upstream call. No HTTP caching — the
 * store is ws-maintained, so responses are always current.
 */
export function merchantAllHandler(c: Context): Response {
  const { merchants } = getMerchants();
  c.header('Cache-Control', 'no-store');
  // S4-7: browse surfaces (home, map, navbar/mobile search) need the whole
  // catalog but never RENDER the long-form description/instructions/terms —
  // only the detail page does, and it pulls those from /by-slug + /:id, not
  // here. `?fields=lite` strips them from this whole-catalog payload, the
  // single biggest browse-payload win as the catalog scales (they're capped at
  // 50k chars each). Default (no param) is unchanged for any other consumer.
  if (c.req.query('fields') === 'lite') {
    return c.json({ merchants: merchants.map(toLiteMerchant), total: merchants.length });
  }
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

  c.header('Cache-Control', 'no-store');
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
    // Same auth split as the order handlers: act-as the user on the
    // Loop-native path (the Loop JWT is not forwardable to CTX),
    // forward the CTX bearer on the legacy path. When a native user
    // has no CTX mapping yet, `headers` is null — we simply skip the
    // enrichment and serve the cached merchant, which is this
    // handler's fail-soft behaviour on any upstream miss anyway.
    const clientId = c.get('clientId') as string | undefined;
    const auth = c.get('auth') as LoopAuthContext | undefined;
    let headers: Record<string, string> | null;
    if (auth?.kind === 'loop') {
      headers = ctxActAsHeaders(await getUserCtxUserId(auth.userId), clientId);
    } else {
      const bearer = c.get('bearerToken') as string | undefined;
      headers = {};
      if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
      if (clientId) headers['X-Client-Id'] = clientId;
    }

    if (headers !== null) {
      const response = await upstreamFetch(upstreamUrl(`/merchants/${id}`), {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const raw = (await response.json().catch(() => null)) as unknown;
        const parsed = UpstreamMerchantDetailResponse.safeParse(raw);
        if (parsed.success && parsed.data.info) {
          const { intro, description, longDescription, terms, instructions } = parsed.data.info;
          // longDescription wins when both are present — it's the
          // full-length body copy, while `description` is often just a
          // headline repeat. Fall back to `description` otherwise.
          if (longDescription) merchant.description = longDescription;
          else if (description) merchant.description = description;
          if (intro) merchant.intro = intro;
          if (terms) merchant.terms = terms;
          if (instructions) merchant.instructions = instructions;
        }
      } else {
        log.warn(
          { id, status: response.status },
          'Upstream /merchants/:id returned non-OK — serving cached',
        );
      }
    }
  } catch (err) {
    log.warn(
      { id, err: err instanceof Error ? err.message : String(err) },
      'Upstream /merchants/:id errored — serving cached',
    );
  }

  c.header('Cache-Control', 'no-store');
  return c.json({ merchant });
}

// Public merchant-cashback-rate handlers (`GET /cashback-rates`
// + `GET /:merchantId/cashback-rate`) live in
// `./cashback-rate-handlers.ts`. Re-exported here so the routes
// module + the historical test-import paths keep resolving.
export {
  merchantsCashbackRatesHandler,
  merchantCashbackRateHandler,
} from './cashback-rate-handlers.js';
