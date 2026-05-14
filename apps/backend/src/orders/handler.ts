import type { Context } from 'hono';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift, notifyOrderCreated } from '../discord.js';
import {
  summariseZodIssues,
  upstreamHeaders,
  CreateOrderUpstreamResponse,
  ORDER_EXPIRY_SECONDS,
  mapStatus,
} from './handler-shared.js';

// Re-exported for `list-handler.ts`, `get-handler.ts`, and the
// CTX contract test which import these from `./handler.js`.
export { summariseZodIssues, upstreamHeaders, CreateOrderUpstreamResponse, mapStatus };

const log = logger.child({ handler: 'orders' });

// Gift card denominations in the wild span roughly $1 to $10k; reject anything
// outside that band to prevent accidental or malicious orders. `.finite()` blocks
// A2-803: the request-body schema lives in `./request-schemas.ts`
// alongside the auth-slice precedent so both this runtime parser and
// the openapi factory in `../openapi/orders.ts` resolve to one shape.
import { CreateOrderBody } from './request-schemas.js';
import { parseSep7PayUri } from './sep7.js';

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
      const body = scrubUpstreamBody(await response.text());
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
      notifyCtxSchemaDrift({
        surface: 'POST /gift-cards',
        issuesSummary: summariseZodIssues(validated.error.issues),
      });
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
    const sep7 = parseSep7PayUri(paymentUri);
    if (!sep7.ok) {
      const messageByError: Record<typeof sep7.error, string> = {
        'wrong-scheme': 'Order payment URL uses an unexpected scheme',
        'missing-destination': 'Order payment URL missing destination',
        'missing-amount': 'Order payment URL missing amount',
        'missing-memo': 'Order payment URL missing memo',
      };
      log.error(
        {
          orderId: validated.data.id,
          merchantId,
          sep7Error: sep7.error,
          paymentUriScheme: paymentUri.slice(0, 32),
        },
        'Upstream XLM payment URL failed SEP-7 parse',
      );
      return c.json({ code: 'UPSTREAM_ERROR', message: messageByError[sep7.error] }, 502);
    }
    const paymentAddress = sep7.value.destination;
    const memo = sep7.value.memo;

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

// `listOrdersHandler` (paginated /api/orders proxy) lives in
// `./list-handler.ts`. Re-exported here so the routes module's
// existing import block keeps working without re-targeting; the
// `ListOrdersUpstreamResponse` schema is also re-exported because
// the ctx-contract test (`__tests__/ctx-contract.test.ts`) parses
// recorded CTX fixtures through it (A2-1706).
export { listOrdersHandler, ListOrdersUpstreamResponse } from './list-handler.js';

// `getOrderHandler` (single-order detail proxy) lives in
// `./get-handler.ts`. The `GetOrderUpstreamResponse` schema is
// re-exported alongside it because the ctx-contract test
// (`__tests__/ctx-contract.test.ts`) parses recorded CTX fixtures
// through it (A2-1706).
export { getOrderHandler, GetOrderUpstreamResponse } from './get-handler.js';
