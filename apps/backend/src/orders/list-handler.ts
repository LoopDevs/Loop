// GET /api/orders handler — AUD-08, R3-11
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift } from '../discord.js';
import { mapStatus, summariseZodIssues, upstreamHeaders } from './handler-shared.js';

const log = logger.child({ handler: 'orders' });

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

const ALLOWED_LIST_QUERY_PARAMS = new Set(['page', 'perPage', 'status']);

const EXCLUDE_PENDING_PARAM = 'excludePending';

const UPSTREAM_FETCH_PER_PAGE = 100;

const MAX_UPSTREAM_PAGE_WALK = 20;

const DEFAULT_LOOP_PER_PAGE = 20;

function parseMoneyOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

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

async function fetchUpstreamOrders(
  c: Context,
  params: Record<string, string>,
): Promise<UpstreamFetchResult> {
  const url = new URL(upstreamUrl('/gift-cards'));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const headers = await upstreamHeaders(c);
  if (headers === null) {
    return {
      ok: true,
      data: { result: [], pagination: { page: 1, pages: 0, perPage: 0, total: 0 } },
    };
  }

  const response = await upstreamFetch(url.toString(), {
    headers,
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

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

function parseExcludePending(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

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
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / loopPerPage));
  const hasNext = capHit ? true : start + loopPerPage < total;
  const hasPrev = loopPage > 1;

  return c.json({
    orders: pageItems,
    pagination: { page: loopPage, limit: loopPerPage, total, totalPages, hasNext, hasPrev },
  });
}

export async function listOrdersHandler(c: Context): Promise<Response> {
  const query = c.req.query();

  try {
    if (parseExcludePending(query[EXCLUDE_PENDING_PARAM])) {
      const loopPage = parsePositiveInt(query['page'], 1);
      const loopPerPage = parsePositiveInt(query['perPage'], DEFAULT_LOOP_PER_PAGE, 100);
      return await listNonPendingOrders(c, loopPage, loopPerPage);
    }

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
    log.error({ err }, 'Order list proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch orders' }, 500);
  }
}
