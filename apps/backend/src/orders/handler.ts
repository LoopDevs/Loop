import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';

const log = logger.child({ handler: 'orders' });

const CreateOrderBody = z.object({
  merchantId: z.string().min(1),
  amount: z.number().positive(),
});

// Upstream response schemas — validate before forwarding to client
const CreateOrderUpstreamResponse = z
  .object({
    orderId: z.string(),
    paymentAddress: z.string(),
    xlmAmount: z.string(),
    expiresAt: z.number(),
  })
  .passthrough();

const GetOrderUpstreamResponse = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    status: z.enum(['pending', 'processing', 'completed', 'failed', 'expired']),
    giftCardCode: z.string().optional(),
    giftCardPin: z.string().optional(),
  })
  .passthrough();

function upstreamUrl(path: string): string {
  return `${env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '')}${path}`;
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

  const bearerToken = c.get('bearerToken') as string;
  const { merchantId, amount } = parsed.data;

  // Look up merchant — reject if not in cache
  const { merchantsById } = getMerchants();
  const merchant = merchantsById.get(merchantId);
  if (merchant === undefined) {
    return c.json({ code: 'NOT_FOUND', message: 'Merchant not found' }, 404);
  }
  const fiatCurrency = merchant.denominations?.currency ?? 'USD';

  try {
    const response = await fetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
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
    return c.json(validated.data, 201);
  } catch (err) {
    log.error({ err, merchantId }, 'Order proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
}

/**
 * GET /api/orders
 * Authenticated. Proxies to upstream GET /gift-cards.
 */
export async function listOrdersHandler(c: Context): Promise<Response> {
  const bearerToken = c.get('bearerToken') as string;

  try {
    const url = new URL(upstreamUrl('/gift-cards'));
    // Pass through any query params (page, status, etc.)
    for (const [key, value] of Object.entries(c.req.query())) {
      url.searchParams.set(key, value as string);
    }

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch orders' }, 502);
    }

    return c.json(await response.json());
  } catch (err) {
    log.error({ err }, 'Order list proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch orders' }, 500);
  }
}

/**
 * GET /api/orders/:id
 * Authenticated. Proxies to upstream GET /gift-cards/:id.
 */
export async function getOrderHandler(c: Context): Promise<Response> {
  const bearerToken = c.get('bearerToken') as string;
  const orderId = c.req.param('id') ?? '';

  // Sanitize order ID — reject path traversal or non-alphanumeric/dash/underscore
  if (!/^[\w-]+$/.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid order ID' }, 400);
  }

  try {
    const response = await fetch(upstreamUrl(`/gift-cards/${orderId}`), {
      headers: { Authorization: `Bearer ${bearerToken}` },
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
    return c.json({ order: validated.data });
  } catch (err) {
    log.error({ err, orderId }, 'Order get proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}
