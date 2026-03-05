import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'orders' });

const CreateOrderBody = z.object({
  merchantId: z.string().min(1),
  amount: z.number().positive(),
});

/**
 * POST /api/orders
 * Authenticated. Proxies to the upstream gift card API.
 */
export async function createOrderHandler(c: Context): Promise<Response> {
  const parsed = CreateOrderBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'merchantId and positive amount are required' }, 400);
  }

  const email = c.get('email') as string | undefined;
  if (!email) {
    return c.json({ code: 'INTERNAL_ERROR', message: 'Missing auth context' }, 500);
  }
  const { merchantId, amount } = parsed.data;

  try {
    const response = await fetch(new URL('/api/orders', env.GIFT_CARD_API_BASE_URL).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': env.GIFT_CARD_API_KEY,
        'X-Api-Secret': env.GIFT_CARD_API_SECRET,
      },
      body: JSON.stringify({ merchantId, amount, email }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error({ status: response.status, body, email, merchantId }, 'Upstream order creation failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Order creation failed' }, 502);
    }

    const order = await response.json();
    return c.json(order, 201);
  } catch (err) {
    log.error({ err, email, merchantId }, 'Order proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
}

/**
 * GET /api/orders
 * Authenticated. Returns paginated order history for the current user.
 */
export async function listOrdersHandler(c: Context): Promise<Response> {
  const email = c.get('email') as string | undefined;
  if (!email) {
    return c.json({ code: 'INTERNAL_ERROR', message: 'Missing auth context' }, 500);
  }
  const page = c.req.query('page') ?? '1';

  try {
    const url = new URL('/api/orders', env.GIFT_CARD_API_BASE_URL);
    url.searchParams.set('email', email);
    url.searchParams.set('page', page);

    const response = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': env.GIFT_CARD_API_KEY,
        'X-Api-Secret': env.GIFT_CARD_API_SECRET,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch orders' }, 502);
    }

    return c.json(await response.json());
  } catch (err) {
    log.error({ err, email }, 'Order list proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch orders' }, 500);
  }
}

/**
 * GET /api/orders/:id
 * Authenticated.
 */
export async function getOrderHandler(c: Context): Promise<Response> {
  const email = c.get('email') as string | undefined;
  if (!email) {
    return c.json({ code: 'INTERNAL_ERROR', message: 'Missing auth context' }, 500);
  }
  const orderId = c.req.param('id');

  try {
    const url = new URL(`/api/orders/${orderId}`, env.GIFT_CARD_API_BASE_URL);
    const response = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': env.GIFT_CARD_API_KEY,
        'X-Api-Secret': env.GIFT_CARD_API_SECRET,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }

    if (!response.ok) {
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch order' }, 502);
    }

    const order = (await response.json()) as { email?: string };
    // Strict ownership: deny if email is missing or does not match the authenticated user.
    // Return 404 (not 403) to prevent order ID enumeration.
    if (order.email !== email) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }

    return c.json(order);
  } catch (err) {
    log.error({ err, email, orderId }, 'Order get proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}
