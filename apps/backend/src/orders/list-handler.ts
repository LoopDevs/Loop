/**
 * `GET /api/orders` handler — paginated list of the caller\'s
 * upstream gift-card orders.
 *
 * Lifted out of `apps/backend/src/orders/handler.ts`. Two modes:
 *
 *   1. Plain upstream proxy (default) — forwards a curated subset
 *      of query params to CTX, validates the response with Zod, and
 *      shapes each row into the Loop OrderListItem contract.
 *   2. AUD-08 exclude-pending mode (`?excludePending=true`) —
 *      server-side pagination over the NON-pending set. CTX cannot
 *      express a `fulfilled|refunded|expired` union / `not pending`
 *      negation on `GET /gift-cards` (it accepts only a single
 *      `status=<value>`), so we cannot ask the upstream for the
 *      filtered set in one query. Instead the backend walks the
 *      upstream pages itself, drops rows whose translated Loop
 *      status is `pending`, and re-paginates the filtered set. This
 *      yields STABLE, COMPLETE non-pending pages (no false-empty
 *      page, no Prev/Next dead-end) without widening what the client
 *      can push to CTX. See docs and the AUD-08 PR for the full
 *      what-CTX-can/can\'t-do writeup.
 *
 * Helpers shared with the create/get handlers
 * (`summariseZodIssues`, `upstreamHeaders`, `mapStatus`) are
 * imported from `./handler-shared.ts` (their real home) rather than
 * duplicated or routed through the create-handler file. The
 * list-only helpers — `ListOrdersUpstreamResponse` schema,
 * `ALLOWED_LIST_QUERY_PARAMS` allowlist, `parseMoneyOrNull` row
 * parser — travel with the slice because they have no other
 * consumers.
 *
 * TRUST BOUNDARY (R3-11): this handler does no local ownership check —
 * it lists whatever orders the upstream bearer token is authorized to
 * see. IDOR defense is delegated entirely to CTX's bearer-scoping (the
 * upstream only returns orders belonging to the token's account); there
 * is no Loop-side `eq(orders.userId, ...)` filter to bypass. Contrast
 * the loop-native path (`orders/loop-read-handlers.ts`), which pins
 * `eq(orders.userId, auth.userId)` locally. This is a deliberate
 * accepted-risk trust boundary, not an oversight — see
 * docs/threat-model.md ("Accepted risks") and ADR-039
 * (docs/adr/039-legacy-order-path-retirement.md), which retires this
 * whole path once its criteria are met.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift } from '../discord.js';
import { mapStatus, summariseZodIssues, upstreamHeaders } from './handler-shared.js';

const log = logger.child({ handler: 'orders' });

// Local schema for the upstream `/gift-cards` list response —
// passthrough to keep unknown fields from breaking validation,
// the explicit fields below are what we actually consume.
const ListOrdersUpstreamItem = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    merchantName: z.string().optional(),
    cardFiatAmount: z.string().optional(),
    cardFiatCurrency: z.string().optional(),
    paymentCryptoAmount: z.string().optional(),
    status: z.string().optional(),
    percentDiscount: z.string().optional(),
    redeemType: z.string().optional(),
    created: z.string().optional(),
  })
  .passthrough();

export const ListOrdersUpstreamResponse = z
  .object({
    result: z.array(ListOrdersUpstreamItem),
    pagination: z.object({
      page: z.number(),
      pages: z.number(),
      perPage: z.number(),
      total: z.number(),
    }),
  })
  .passthrough();

type UpstreamListItem = z.infer<typeof ListOrdersUpstreamItem>;

// Only these upstream query params are safe to forward verbatim to
// CTX. Blind passthrough would let a client inject upstream-only
// parameters (e.g. to read another user\'s data if CTX naively
// respected a `userId` param), so the forward loop is a strict
// allowlist, NOT a denylist.
//
// AUD-08: this set is deliberately UNCHANGED. The new
// `excludePending` control is a *Loop-side* param — it is parsed and
// consumed by this handler and is NEVER forwarded to CTX (see
// `EXCLUDE_PENDING_PARAM` below). Adding a client-controlled
// status-negation to what reaches the upstream is exactly the
// injection surface this allowlist exists to prevent, so we keep the
// forwarded set to CTX-native params only. In exclude-pending mode
// the backend drives CTX pagination with server-CONSTRUCTED `page`/
// `perPage` values — no client string reaches the upstream URL.
const ALLOWED_LIST_QUERY_PARAMS = new Set(['page', 'perPage', 'status']);

// AUD-08 Loop-side control param. Consumed locally; intentionally
// absent from `ALLOWED_LIST_QUERY_PARAMS` so it can never be
// forwarded to CTX.
const EXCLUDE_PENDING_PARAM = 'excludePending';

// CTX caps `perPage` at 100 (see the openapi query schema). Fetch
// the widest page the upstream allows while walking so exclude-pending
// aggregation makes as few round-trips as possible.
const UPSTREAM_FETCH_PER_PAGE = 100;

// Safety cap on server-side fan-out. At 100 rows/page this scans up
// to 2,000 of the caller\'s orders — generous for real order
// histories — while bounding the worst-case upstream load a single
// list request can generate. If a caller exceeds it we serve what we
// gathered and mark `hasNext` true (there may be more) rather than
// walking unboundedly.
const MAX_UPSTREAM_PAGE_WALK = 20;

// Loop-side page size when the client omits `perPage`. Matches the
// CTX default the plain-proxy path returns today so exclude-pending
// mode doesn\'t silently change the page size.
const DEFAULT_LOOP_PER_PAGE = 20;

/**
 * List-safe variant of money parsing — returns null on non-numeric
 * input. The list handler filters null rows out rather than
 * crashing the whole response — one order with a malformed
 * `cardFiatAmount` should not hide the user\'s entire purchase
 * history.
 */
function parseMoneyOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** The Loop OrderListItem row shape returned to the client. */
interface OrderListRow {
  id: string;
  merchantId: string;
  merchantName: string;
  amount: number;
  currency: string;
  status: ReturnType<typeof mapStatus>;
  xlmAmount: string;
  percentDiscount: string | undefined;
  redeemType: string | undefined;
  createdAt: string | undefined;
}

/**
 * Shapes one validated upstream item into the Loop row contract, or
 * `null` when its `cardFiatAmount` is non-numeric (skip the row, keep
 * the rest of the list — see `parseMoneyOrNull`).
 */
function shapeOrder(item: UpstreamListItem): OrderListRow | null {
  const amount = parseMoneyOrNull(item.cardFiatAmount);
  if (amount === null) {
    log.warn(
      { orderId: item.id, rawAmount: item.cardFiatAmount },
      'Skipping order with non-numeric cardFiatAmount from upstream',
    );
    return null;
  }
  return {
    id: item.id,
    merchantId: item.merchantId,
    merchantName: item.merchantName ?? '',
    amount,
    currency: item.cardFiatCurrency ?? 'USD',
    status: mapStatus(item.status ?? 'unpaid'),
    xlmAmount: item.paymentCryptoAmount ?? '0',
    percentDiscount: item.percentDiscount,
    redeemType: item.redeemType,
    createdAt: item.created,
  };
}

type UpstreamFetchResult =
  | { ok: true; data: z.infer<typeof ListOrdersUpstreamResponse> }
  | { ok: false; response: Response };

/**
 * Performs one validated upstream `GET /gift-cards` request. `params`
 * is the EXACT set of query params placed on the upstream URL — the
 * caller is responsible for it being either the strict allowlist
 * projection of the client query (plain-proxy path) or
 * server-constructed values (exclude-pending path). No client string
 * is ever passed through here unfiltered.
 */
async function fetchUpstreamOrders(
  c: Context,
  params: Record<string, string>,
): Promise<UpstreamFetchResult> {
  const url = new URL(upstreamUrl('/gift-cards'));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await getUpstreamCircuit('gift-cards').fetch(url.toString(), {
    headers: upstreamHeaders(c),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 401) {
    return {
      ok: false,
      response: c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401),
    };
  }

  if (!response.ok) {
    const body = scrubUpstreamBody(await response.text());
    log.error({ status: response.status, body }, 'Upstream order list failed');
    return {
      ok: false,
      response: c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch orders' }, 502),
    };
  }

  const raw = await response.json();
  const validated = ListOrdersUpstreamResponse.safeParse(raw);
  if (!validated.success) {
    log.error(
      { issues: validated.error.issues },
      'Upstream order list response did not match expected shape',
    );
    notifyCtxSchemaDrift({
      surface: 'GET /gift-cards',
      issuesSummary: summariseZodIssues(validated.error.issues),
    });
    return {
      ok: false,
      response: c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      ),
    };
  }

  return { ok: true, data: validated.data };
}

/** Parses a `?page=` / `?perPage=` value; falls back to `fallback` on junk. */
function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

/** True only for the explicit opt-in tokens; anything else is false. */
function parseExcludePending(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

/**
 * AUD-08 exclude-pending mode. Walks the caller\'s upstream order
 * pages, drops rows whose translated Loop status is `pending`, and
 * serves a stable/complete page of the filtered set.
 */
async function listNonPendingOrders(
  c: Context,
  loopPage: number,
  loopPerPage: number,
): Promise<Response> {
  const filtered: OrderListRow[] = [];
  let upstreamPage = 1;
  let capHit = false;

  while (true) {
    const result = await fetchUpstreamOrders(c, {
      page: String(upstreamPage),
      perPage: String(UPSTREAM_FETCH_PER_PAGE),
    });
    if (!result.ok) return result.response;

    for (const item of result.data.result) {
      // Filter on the RAW upstream status, translated through the
      // same `mapStatus` the client sees, so "non-pending" here means
      // exactly what the client would keep after dropping `pending`.
      if (mapStatus(item.status ?? 'unpaid') === 'pending') continue;
      const shaped = shapeOrder(item);
      if (shaped !== null) filtered.push(shaped);
    }

    const { page, pages } = result.data.pagination;
    if (page >= pages || result.data.result.length === 0) {
      break;
    }
    upstreamPage += 1;
    if (upstreamPage > MAX_UPSTREAM_PAGE_WALK) {
      capHit = true;
      break;
    }
  }

  if (capHit) {
    log.warn(
      { maxPages: MAX_UPSTREAM_PAGE_WALK, gathered: filtered.length },
      'Exclude-pending aggregation hit the page-walk cap — totals are a floor. ' +
        'This account is large enough to justify the CTX-side status-union fix.',
    );
  }

  const start = (loopPage - 1) * loopPerPage;
  const pageItems = filtered.slice(start, start + loopPerPage);
  const total = filtered.length; // exact when exhausted; a floor when capHit
  const totalPages = Math.max(1, Math.ceil(total / loopPerPage));
  // When the cap was hit we cannot rule out more filtered rows upstream,
  // so keep Next alive rather than stranding the user.
  const hasNext = capHit ? true : start + loopPerPage < total;
  const hasPrev = loopPage > 1;

  return c.json({
    orders: pageItems,
    pagination: { page: loopPage, limit: loopPerPage, total, totalPages, hasNext, hasPrev },
  });
}

/**
 * GET /api/orders
 * Authenticated. Proxies to upstream GET /gift-cards.
 */
export async function listOrdersHandler(c: Context): Promise<Response> {
  // bearerToken + clientId handled by upstreamHeaders(c)
  const query = c.req.query();

  try {
    if (parseExcludePending(query[EXCLUDE_PENDING_PARAM])) {
      const loopPage = parsePositiveInt(query['page'], 1);
      const loopPerPage = parsePositiveInt(query['perPage'], DEFAULT_LOOP_PER_PAGE, 100);
      return await listNonPendingOrders(c, loopPage, loopPerPage);
    }

    // Plain-proxy path (unchanged): forward only allowlisted,
    // CTX-native params verbatim and pass the upstream pagination
    // straight through.
    const forwarded: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (ALLOWED_LIST_QUERY_PARAMS.has(key)) {
        forwarded[key] = value as string;
      }
    }

    const result = await fetchUpstreamOrders(c, forwarded);
    if (!result.ok) return result.response;

    const orders = result.data.result.flatMap((item) => {
      const shaped = shapeOrder(item);
      return shaped === null ? [] : [shaped];
    });

    const { page, pages, perPage, total } = result.data.pagination;
    return c.json({
      orders,
      pagination: {
        page,
        limit: perPage,
        total,
        totalPages: pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err }, 'Order list proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch orders' }, 500);
  }
}
