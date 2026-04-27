/**
 * `GET /api/orders` handler — paginated list of the caller\'s
 * upstream gift-card orders.
 *
 * Lifted out of `apps/backend/src/orders/handler.ts`. Pure
 * upstream proxy: forwards a curated subset of query params to
 * CTX, validates the response with Zod, and shapes each row into
 * the Loop OrderListItem contract.
 *
 * Helpers shared with the create/get handlers
 * (`summariseZodIssues`, `upstreamHeaders`, `mapStatus`) are
 * imported from `./handler.ts` rather than duplicated. The
 * list-only helpers — `ListOrdersUpstreamResponse` schema,
 * `ALLOWED_LIST_QUERY_PARAMS` allowlist, `parseMoneyOrNull` row
 * parser — travel with the slice because they have no other
 * consumers.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift } from '../discord.js';
import { mapStatus, summariseZodIssues, upstreamHeaders } from './handler.js';

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

// Only these upstream query params are safe to forward. Blind
// passthrough would let a client inject upstream-only parameters
// (e.g. to read another user\'s data if CTX naively respected a
// `userId` param).
const ALLOWED_LIST_QUERY_PARAMS = new Set(['page', 'perPage', 'status']);

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

/**
 * GET /api/orders
 * Authenticated. Proxies to upstream GET /gift-cards.
 */
export async function listOrdersHandler(c: Context): Promise<Response> {
  // bearerToken + clientId handled by upstreamHeaders(c)

  try {
    const url = new URL(upstreamUrl('/gift-cards'));
    for (const [key, value] of Object.entries(c.req.query())) {
      if (ALLOWED_LIST_QUERY_PARAMS.has(key)) {
        url.searchParams.set(key, value as string);
      }
    }

    const response = await getUpstreamCircuit('gift-cards').fetch(url.toString(), {
      headers: upstreamHeaders(c),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      const body = scrubUpstreamBody(await response.text());
      log.error({ status: response.status, body }, 'Upstream order list failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch orders' }, 502);
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
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const orders = validated.data.result.flatMap((item) => {
      const amount = parseMoneyOrNull(item.cardFiatAmount);
      if (amount === null) {
        log.warn(
          { orderId: item.id, rawAmount: item.cardFiatAmount },
          'Skipping order with non-numeric cardFiatAmount from upstream',
        );
        return [];
      }
      return [
        {
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
        },
      ];
    });

    const { page, pages, perPage, total } = validated.data.pagination;
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
