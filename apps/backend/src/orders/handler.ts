import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import { upstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';

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

const CreateOrderBody = z.object({
  merchantId: z.string().min(1),
  amount: z.number().positive(),
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

/** Maps upstream CTX status values to our normalized OrderStatus. */
function mapStatus(ctxStatus: string): 'pending' | 'completed' | 'failed' | 'expired' {
  if (ctxStatus === 'fulfilled') return 'completed';
  if (ctxStatus === 'expired') return 'expired';
  if (ctxStatus === 'refunded') return 'failed';
  return 'pending'; // unpaid, processing, etc.
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
    const response = await upstreamCircuit.fetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: {
        ...upstreamHeaders(c),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cryptoCurrency: 'XLM',
        fiatCurrency,
        fiatAmount: String(amount),
        merchantId,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      const body = await response.text();
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

    const paymentUri = validated.data.paymentUrls?.['XLM'] ?? '';
    // Parse destination and memo from stellar URI: web+stellar:pay?destination=X&amount=Y&memo=Z
    const uriParams = new URLSearchParams(paymentUri.replace(/^web\+stellar:pay\?/, ''));
    const paymentAddress = uriParams.get('destination') ?? '';
    const memo = decodeURIComponent(uriParams.get('memo') ?? '');

    return c.json(
      {
        orderId: validated.data.id,
        paymentUri,
        paymentAddress,
        xlmAmount: validated.data.paymentCryptoAmount,
        memo,
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
    // Pass through any query params (page, status, etc.)
    for (const [key, value] of Object.entries(c.req.query())) {
      url.searchParams.set(key, value as string);
    }

    const response = await upstreamCircuit.fetch(url.toString(), {
      headers: upstreamHeaders(c),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch orders' }, 502);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || !('result' in raw) || !('pagination' in raw)) {
      log.error('Upstream order list response has unexpected shape');
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const upstream = raw as {
      result: Array<Record<string, unknown>>;
      pagination: { page: number; pages: number; perPage: number; total: number };
    };

    const orders = upstream.result.map((item) => ({
      id: item.id,
      merchantId: item.merchantId,
      merchantName: item.merchantName ?? '',
      amount: parseFloat(String(item.cardFiatAmount ?? '0')) || 0,
      currency: item.cardFiatCurrency ?? 'USD',
      status: mapStatus(String(item.status ?? 'unpaid')),
      xlmAmount: item.paymentCryptoAmount ?? '0',
      percentDiscount: item.percentDiscount,
      redeemType: item.redeemType,
      createdAt: item.created,
    }));

    return c.json({
      orders,
      pagination: {
        page: upstream.pagination.page,
        limit: upstream.pagination.perPage,
        total: upstream.pagination.total,
        totalPages: upstream.pagination.pages,
        hasNext: upstream.pagination.page < upstream.pagination.pages,
        hasPrev: upstream.pagination.page > 1,
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
    const response = await upstreamCircuit.fetch(upstreamUrl(`/gift-cards/${orderId}`), {
      headers: upstreamHeaders(c),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
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
      amount: parseFloat(validated.data.cardFiatAmount) || 0,
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
