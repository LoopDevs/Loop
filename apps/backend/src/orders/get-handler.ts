// GET /api/orders/:id — single-order detail proxy — ADR-039, R3-11
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift, notifyOrderFulfilled } from '../discord.js';
import { mapStatus, summariseZodIssues, upstreamHeaders } from './handler-shared.js';
import { applyBarcodeFields } from './barcode-fields.js';

const log = logger.child({ handler: 'orders' });

// A2-1706
export const GetOrderUpstreamResponse = z
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
    // CF-02: cap CTX-supplied scripts at trust boundary (run in merchant WebView)
    redeemScripts: z
      .object({
        injectChallenge: z.string().max(100_000).optional(),
        scrapeResult: z.string().max(100_000).optional(),
      })
      .optional(),
    created: z.string(),
  })
  .passthrough();

// Throws on non-numeric to prevent silent $0 treatment of corrupt data
function parseMoney(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Non-numeric money value from upstream: ${JSON.stringify(raw)}`);
  }
  return n;
}

const notifiedFulfilled = new Set<string>();
const NOTIFIED_FULFILLED_MAX = 10_000;

function markFulfilledNotified(orderId: string): void {
  if (notifiedFulfilled.size >= NOTIFIED_FULFILLED_MAX) {
    const oldest = notifiedFulfilled.values().next().value;
    if (oldest !== undefined) notifiedFulfilled.delete(oldest);
  }
  notifiedFulfilled.add(orderId);
}

export async function getOrderHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('id') ?? '';

  if (!/^[\w-]+$/.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid order ID' }, 400);
  }

  const headers = await upstreamHeaders(c);
  if (headers === null) {
    // Loop-native user with no CTX mapping: order cannot belong to a CTX identity
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }

  try {
    const response = await upstreamFetch(upstreamUrl(`/gift-cards/${orderId}`), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }

    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    if (!response.ok) {
      const body = scrubUpstreamBody(await response.text());
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
      notifyCtxSchemaDrift({
        surface: 'GET /gift-cards/:id',
        issuesSummary: summariseZodIssues(validated.error.issues),
      });
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const status = mapStatus(validated.data.status);
    const amount = parseMoney(validated.data.cardFiatAmount);
    const currency = validated.data.cardFiatCurrency ?? 'USD';

    if (status === 'completed' && !notifiedFulfilled.has(validated.data.id)) {
      log.info(
        {
          orderId: validated.data.id,
          rawKeys: Object.keys(validated.data),
          redeemType: validated.data.redeemType,
          hasRedeemUrl: validated.data.redeemUrl !== undefined,
          hasRedeemUrlChallenge: validated.data.redeemUrlChallenge !== undefined,
          ctxStatus: validated.data.status,
        },
        'Completed order — CTX response shape',
      );
    }

    const order: Record<string, unknown> = {
      id: validated.data.id,
      merchantId: validated.data.merchantId,
      merchantName: validated.data.merchantName ?? '',
      amount,
      currency,
      status,
      xlmAmount: validated.data.paymentCryptoAmount ?? '0',
      percentDiscount: validated.data.percentDiscount,
      redeemType: validated.data.redeemType,
      createdAt: validated.data.created,
    };

    if (validated.data.redeemUrl) {
      order.redeemUrl = validated.data.redeemUrl;
    }
    if (validated.data.redeemUrlChallenge) {
      order.redeemChallengeCode = validated.data.redeemUrlChallenge;
    }
    if (validated.data.redeemScripts) {
      order.redeemScripts = validated.data.redeemScripts;
    }

    // ADR-005 §2
    if (status === 'completed' && validated.data.redeemType === 'barcode') {
      applyBarcodeFields({
        upstream: validated.data as unknown as Record<string, unknown>,
        orderId: validated.data.id,
        order,
        log,
      });
    }

    if (status === 'completed' && !notifiedFulfilled.has(validated.data.id)) {
      markFulfilledNotified(validated.data.id);
      notifyOrderFulfilled({
        orderId: validated.data.id,
        merchantId: validated.data.merchantName ?? '',
        faceValueMinor: BigInt(Math.round(amount * 100)),
        currency,
      });
    }

    return c.json({ order });
  } catch (err) {
    log.error({ err, orderId }, 'Order get proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch order' }, 500);
  }
}
