import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { notifyOrderCreated } from '../discord.js';

const log = logger.child({ handler: 'orders' });

/** Builds auth headers for upstream requests, including optional X-Client-Id. */
function upstreamHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.get('bearerToken') as string}`,
  };
  const clientId = c.get('clientId') as string | undefined;
  if (clientId) {
    headers['X-Client-Id'] = clientId;
  }
  return headers;
}

// Gift card denominations in the wild span roughly $1 to $10k; reject anything
// outside that band to prevent accidental or malicious orders. `.finite()` blocks
// Infinity/NaN; `.multipleOf(0.01)` enforces cents-precision so we never send
// IEEE-754 garbage (0.1 + 0.2 = 0.30000000000000004) to upstream.
const CreateOrderBody = z.object({
  merchantId: z.string().min(1).max(128),
  amount: z.number().finite().positive().min(0.01).max(10_000).multipleOf(0.01),
});

// Upstream response schemas — validate before forwarding to client
const CreateOrderUpstreamResponse = z
  .object({
    id: z.string(),
    paymentCryptoAmount: z.string(),
    paymentUrls: z.record(z.string(), z.string()).optional(),
    status: z.string(),
  })
  .passthrough();

/**
 * Seconds the client should consider an order valid for payment. The client
 * used to hardcode this to now() + 30min, which drifted relative to the
 * server under any clock skew — the payment countdown could expire mid-pay or
 * show a bogus value. Now the server computes and returns the expiry, making
 * the backend authoritative for the payment window.
 *
 * If CTX starts returning its own expiry in the `/gift-cards` response we can
 * prefer that; for now the upstream schema doesn't surface one.
 */
const ORDER_EXPIRY_SECONDS = 30 * 60;

const GetOrderUpstreamResponse = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    merchantName: z.string().optional(),
    cardFiatAmount: z.string(),
    cardFiatCurrency: z.string().optional(),
    paymentCryptoAmount: z.string().optional(),
    status: z.string(),
    fulfilmentStatus: z.string().optional(),
    percentDiscount: z.string().optional(),
    redeemType: z.string().optional(),
    redeemUrl: z.string().optional(),
    redeemUrlChallenge: z.string().optional(),
    redeemScripts: z
      .object({
        injectChallenge: z.string().optional(),
        scrapeResult: z.string().optional(),
      })
      .optional(),
    created: z.string(),
  })
  .passthrough();

// Upstream list-orders response — previously cast with `as`, now Zod-validated
// so an unexpected shape fails fast with a clear 502 instead of corrupting JSON.
const ListOrdersUpstreamItem = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    merchantName: z.string().optional(),
    cardFiatAmount: z.string().optional(),
    cardFiatCurrency: z.string().optional(),
    status: z.string().optional(),
    paymentCryptoAmount: z.string().optional(),
    percentDiscount: z.string().optional(),
    redeemType: z.string().optional(),
    created: z.string().optional(),
  })
  .passthrough();

const ListOrdersUpstreamResponse = z
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

// Only these upstream query params are safe to forward. Blind passthrough
// would let a client inject upstream-only parameters (e.g. to read another
// user's data if CTX naively respected a `userId` param).
const ALLOWED_LIST_QUERY_PARAMS = new Set(['page', 'perPage', 'status']);

/** Maps upstream CTX status values to our normalized OrderStatus. */
function mapStatus(ctxStatus: string): 'pending' | 'completed' | 'failed' | 'expired' {
  if (ctxStatus === 'fulfilled') return 'completed';
  if (ctxStatus === 'expired') return 'expired';
  if (ctxStatus === 'refunded') return 'failed';
  const known = new Set(['unpaid', 'processing', 'paid', 'pending']);
  if (!known.has(ctxStatus)) {
    log.warn({ ctxStatus }, 'Unknown upstream order status — defaulting to pending');
  }
  return 'pending';
}

/**
 * Parses a money string from upstream. Returns 0 only for missing/empty values.
 * Throws on a non-numeric string so the single-order handler never silently
 * treats corrupt data as $0. List callers use `parseMoneyOrNull` instead so
 * one bad row doesn't 500 the whole page.
 */
function parseMoney(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Non-numeric money value from upstream: ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * List-safe variant: returns null on non-numeric input. The list handler
 * filters null rows out rather than crashing the whole response — one
 * order with a malformed `cardFiatAmount` should not hide the user's
 * entire purchase history.
 */
function parseMoneyOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * POST /api/orders
 * Authenticated. Proxies to upstream POST /gift-cards.
 */
export async function createOrderHandler(c: Context): Promise<Response> {
  const parsed = CreateOrderBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'merchantId and positive amount are required' },
      400,
    );
  }

  // bearerToken + clientId handled by upstreamHeaders(c)
  const { merchantId, amount } = parsed.data;

  // Look up merchant — reject if not in cache
  const { merchantsById } = getMerchants();
  const merchant = merchantsById.get(merchantId);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }
  const fiatCurrency = merchant.denominations?.currency ?? 'USD';

  try {
    const response = await getUpstreamCircuit('gift-cards').fetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: {
        ...upstreamHeaders(c),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cryptoCurrency: 'XLM',
        fiatCurrency,
        fiatAmount: amount.toFixed(2),
        merchantId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      // Truncate the body before logging — pino redact only matches structured
      // field names, not substrings of strings. Cap at 500 chars as
      // defense-in-depth against an upstream echoing sensitive data.
      const body = (await response.text()).slice(0, 500);
      log.error({ status: response.status, body, merchantId }, 'Upstream order creation failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Order creation failed' }, 502);
    }

    const raw = await response.json();
    const validated = CreateOrderUpstreamResponse.safeParse(raw);
    if (!validated.success) {
      log.error(
        { issues: validated.error.issues },
        'Upstream order response did not match expected shape',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const paymentUri = validated.data.paymentUrls?.['XLM'];
    // An order with no XLM payment URL is unpayable. Fail loudly here rather
    // than returning a 201 with an empty URI — the client would otherwise
    // show a broken payment screen and blame us for silently accepting the
    // order upstream.
    if (paymentUri === undefined || paymentUri === '') {
      log.error(
        { orderId: validated.data.id, merchantId },
        'Upstream order created without XLM payment URL',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Order created but no payment URL available' },
        502,
      );
    }
    // Parse destination and memo from stellar URI: web+stellar:pay?destination=X&amount=Y&memo=Z
    const uriParams = new URLSearchParams(paymentUri.replace(/^web\+stellar:pay\?/, ''));
    const paymentAddress = uriParams.get('destination') ?? '';
    // URLSearchParams.get() already decodes percent-encoding. Calling decodeURIComponent
    // again would double-decode (and throw on malformed sequences like "%ZZ"). Use raw value.
    const memo = uriParams.get('memo') ?? '';

    // Notify Discord
    notifyOrderCreated(
      validated.data.id,
      merchant.name,
      amount,
      fiatCurrency,
      validated.data.paymentCryptoAmount,
    );

    return c.json(
      {
        orderId: validated.data.id,
        paymentUri,
        paymentAddress,
        xlmAmount: validated.data.paymentCryptoAmount,
        memo,
        expiresAt: Math.floor(Date.now() / 1000) + ORDER_EXPIRY_SECONDS,
      },
      201,
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err, merchantId }, 'Order proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
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
      const body = (await response.text()).slice(0, 500);
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

/**
 * GET /api/orders/:id
 * Authenticated. Proxies to upstream GET /gift-cards/:id.
 */
export async function getOrderHandler(c: Context): Promise<Response> {
  // bearerToken + clientId handled by upstreamHeaders(c)
  const orderId = c.req.param('id') ?? '';

  // Sanitize order ID — reject path traversal or non-alphanumeric/dash/underscore
  if (!/^[\w-]+$/.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid order ID' }, 400);
  }

  try {
    const response = await getUpstreamCircuit('gift-cards').fetch(
      upstreamUrl(`/gift-cards/${orderId}`),
      {
        headers: upstreamHeaders(c),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (response.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      log.error({ status: response.status, body, orderId }, 'Upstream order fetch failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch order' }, 502);
    }

    const raw = await response.json();
    const validated = GetOrderUpstreamResponse.safeParse(raw);
    if (!validated.success) {
      log.error(
        { issues: validated.error.issues, orderId },
        'Upstream order detail did not match expected shape',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const order: Record<string, unknown> = {
      id: validated.data.id,
      merchantId: validated.data.merchantId,
      merchantName: validated.data.merchantName ?? '',
      amount: parseMoney(validated.data.cardFiatAmount),
      currency: validated.data.cardFiatCurrency ?? 'USD',
      status: mapStatus(validated.data.status),
      xlmAmount: validated.data.paymentCryptoAmount ?? '0',
      percentDiscount: validated.data.percentDiscount,
      redeemType: validated.data.redeemType,
      createdAt: validated.data.created,
    };

    // Add redemption fields based on type
    if (validated.data.redeemUrl) {
      order.redeemUrl = validated.data.redeemUrl;
    }
    if (validated.data.redeemUrlChallenge) {
      order.redeemChallengeCode = validated.data.redeemUrlChallenge;
    }
    if (validated.data.redeemScripts) {
      order.redeemScripts = validated.data.redeemScripts;
    }

    return c.json({ order });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        503,
      );
    }
    log.error({ err, orderId }, 'Order get proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}
