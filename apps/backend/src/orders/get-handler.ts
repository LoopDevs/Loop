/**
 * `GET /api/orders/:id` handler — single-order detail proxy.
 *
 * Lifted out of `apps/backend/src/orders/handler.ts`. Validates
 * the orderId path param, proxies to upstream
 * `/gift-cards/:id`, validates the response with Zod, and shapes
 * the row into the Loop OrderDetail contract — including the
 * barcode + redeem-URL extraction logic that fires once on the
 * first observed `completed` status, plus the
 * `notifyOrderFulfilled` Discord ping which is dedup\'d via
 * the bounded `notifiedFulfilled` set so repeated polls of the
 * same order don\'t spam the channel.
 *
 * Helpers shared with the create/list handlers
 * (`summariseZodIssues`, `upstreamHeaders`, `mapStatus`) are
 * imported from `./handler.ts` so all three handlers stay in
 * lockstep on schema/header/status conventions.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getUpstreamCircuit, CircuitOpenError } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { notifyCtxSchemaDrift, notifyOrderFulfilled } from '../discord.js';
import { mapStatus, summariseZodIssues, upstreamHeaders } from './handler.js';

const log = logger.child({ handler: 'orders' });

// Upstream response schema for `/gift-cards/:id`. A2-1706: exported
// so the contract test can parse recorded fixtures through it.
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
    redeemScripts: z
      .object({
        injectChallenge: z.string().optional(),
        scrapeResult: z.string().optional(),
      })
      .optional(),
    created: z.string(),
  })
  .passthrough();

/**
 * Parses a money string from upstream. Returns 0 only for missing/
 * empty values. Throws on a non-numeric string so the single-order
 * handler never silently treats corrupt data as $0. The list handler
 * has its own list-safe variant (`parseMoneyOrNull`) that keeps one
 * bad row from 500-ing the whole page.
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
 * Tracks which order ids we\'ve already Discord-notified as fulfilled,
 * so repeated PaymentStep / orders-page polls of a completed order
 * don\'t spam the channel. Keyed on `orderId` alone (status is
 * implicit: entry exists iff we\'ve notified). Bounded so a holder
 * of a valid bearer can\'t exhaust memory by polling synthetic ids.
 */
const notifiedFulfilled = new Set<string>();
const NOTIFIED_FULFILLED_MAX = 10_000;

function markFulfilledNotified(orderId: string): void {
  if (notifiedFulfilled.size >= NOTIFIED_FULFILLED_MAX) {
    const oldest = notifiedFulfilled.values().next().value;
    if (oldest !== undefined) notifiedFulfilled.delete(oldest);
  }
  notifiedFulfilled.add(orderId);
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

    // Diagnostic: on every completed order, log the raw CTX response's
    // key set + redeemType value so we can see what the upstream
    // actually returns. PaymentStep only transitions out of "waiting"
    // when it finds (a) redeemUrl + redeemChallengeCode, (b)
    // giftCardCode, or (c) an error. If none of those are populated
    // here, the user sees the "details unavailable" failure branch —
    // these logs tell us which field mapping is missing. Dedup'd
    // against `notifiedFulfilled` so we only log once per order.
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

    // Barcode-type fulfilled orders — extract the card `number` + `pin`
    // directly from the `/gift-cards/:id` response. CTX populates
    // these fields on the SAME response (via passthrough) once
    // fulfilmentStatus flips to completed; no separate endpoint is
    // required. Verified from the observed response keys on
    // 2026-04-20: ["…","number","pin","barcodeType","barcodeUrl",…].
    // ADR-005 §2 tracked this as Phase 2 — the frontend's
    // PurchaseComplete component already renders the code + jsbarcode
    // canvas whenever `giftCardCode` is present, so once we populate
    // it here the barcode-merchant purchase flow completes end-to-end.
    if (status === 'completed' && validated.data.redeemType === 'barcode') {
      const extras = validated.data as unknown as Record<string, unknown>;
      const pickString = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const v = extras[key];
          if (typeof v === 'string' && v.length > 0) return v;
        }
        return undefined;
      };

      const code = pickString('number', 'code', 'cardNumber', 'giftCardCode');
      const pin = pickString('pin', 'cardPin', 'giftCardPin');
      const imageUrl = pickString('barcodeUrl', 'imageUrl', 'barcodeImageUrl', 'giftCardImageUrl');

      if (code) order.giftCardCode = code;
      if (pin) order.giftCardPin = pin;
      if (imageUrl) order.barcodeImageUrl = imageUrl;

      log.info(
        {
          orderId: validated.data.id,
          extracted: {
            hasCode: code !== undefined,
            hasPin: pin !== undefined,
            hasImageUrl: imageUrl !== undefined,
          },
        },
        'Barcode gift card extracted from /gift-cards/:id response',
      );
    }

    // Wire up the fulfilled-order Discord notification. This handler is
    // the only place that sees upstream status transitions — PaymentStep
    // polls here every 3s during a purchase, so the first poll after
    // CTX flips to `fulfilled` is the right fire-once hook. A bounded
    // in-memory set prevents repeated notifications for the same order
    // on subsequent polls or a returning user refreshing orders.
    if (status === 'completed' && !notifiedFulfilled.has(validated.data.id)) {
      markFulfilledNotified(validated.data.id);
      notifyOrderFulfilled(
        validated.data.id,
        validated.data.merchantName ?? '',
        amount,
        currency,
        validated.data.redeemType ?? 'unknown',
      );
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
