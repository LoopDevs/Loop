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
// Prevents pathological `q` strings from running includes() against an unbounded pattern
const MAX_QUERY_LENGTH = 100;

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

// Audit A-002: serves full catalog to avoid silent truncation by /api/merchants page cap
export function merchantAllHandler(c: Context): Response {
  const { merchants } = getMerchants();
  c.header('Cache-Control', 'no-store');
  // S4-7: strips long-form fields for browse surfaces to reduce payload size
  if (c.req.query('fields') === 'lite') {
    return c.json({ merchants: merchants.map(toLiteMerchant), total: merchants.length });
  }
  return c.json({ merchants, total: merchants.length });
}

export function merchantBySlugHandler(c: Context): Response {
  // Accept case-insensitive match so hand-typed URLs resolve instead of 404'ing
  const slug = (c.req.param('slug') ?? '').toLowerCase();
  const { merchantsBySlug } = getMerchants();

  const merchant = merchantsBySlug.get(slug);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }

  c.header('Cache-Control', 'no-store');
  return c.json({ merchant });
}

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
    // Loop JWT is not forwardable to CTX; act-as headers required for native users
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
          // longDescription is full-length body copy; description is often just a headline repeat
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

// Re-exported so routes module + historical test-import paths keep resolving
export {
  merchantsCashbackRatesHandler,
  merchantCashbackRateHandler,
} from './cashback-rate-handlers.js';
