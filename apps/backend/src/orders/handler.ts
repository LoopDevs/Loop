import type { Context } from 'hono';
import { z } from 'zod';
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
// Infinity/NaN; `.multipleOf(0.01)` enforces cents-precision so we never send
// IEEE-754 garbage (0.1 + 0.2 = 0.30000000000000004) to upstream.
const CreateOrderBody = z.object({
  merchantId: z.string().min(1).max(128),
  amount: z.number().finite().positive().min(0.01).max(10_000).multipleOf(0.01),
});

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
    // Parse destination and memo from stellar URI: web+stellar:pay?destination=X&amount=Y&memo=Z
    //
    // Previously this replace+URLSearchParams path would silently coerce any
    // non-matching URI (e.g. a `bitcoin:` URL if CTX ever reshuffled schemes)
    // into a "no-op replace → URLSearchParams of the whole string" flow that
    // produced empty destination + memo, leading to a 201 with unpayable
    // data. Validate the scheme up front so a schema shift from upstream
    // surfaces as 502 instead of a silently-broken payment screen.
    const STELLAR_PAY_PREFIX = 'web+stellar:pay?';
    if (!paymentUri.startsWith(STELLAR_PAY_PREFIX)) {
      log.error(
        { orderId: validated.data.id, merchantId, paymentUriScheme: paymentUri.slice(0, 32) },
        'Upstream XLM payment URL does not use the expected web+stellar:pay? scheme',
      );
      return c.json(
        {
          code: 'UPSTREAM_ERROR',
          message: 'Order payment URL uses an unexpected scheme',
        },
        502,
      );
    }
    const uriParams = new URLSearchParams(paymentUri.slice(STELLAR_PAY_PREFIX.length));
    const paymentAddress = uriParams.get('destination') ?? '';
    // URLSearchParams.get() already decodes percent-encoding. Calling decodeURIComponent
    // again would double-decode (and throw on malformed sequences like "%ZZ"). Use raw value.
    const memo = uriParams.get('memo') ?? '';
    if (paymentAddress === '') {
      log.error(
        { orderId: validated.data.id, merchantId },
        'Upstream XLM payment URL missing destination parameter',
      );
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Order payment URL missing destination' },
        502,
      );
    }
    if (memo === '') {
      // CTX uses a shared custodial Stellar wallet + per-order memo to match
      // incoming payments to orders. A URI without memo means a user who
      // pays it will have their XLM credited, but CTX can never associate
      // the payment with this order — the order times out and the XLM is
      // effectively lost to support. Fail closed here so the frontend never
      // shows an unpayable payment screen.
      log.error(
        { orderId: validated.data.id, merchantId },
        'Upstream XLM payment URL missing memo parameter',
      );
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Order payment URL missing memo' }, 502);
    }

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
