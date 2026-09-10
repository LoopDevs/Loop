// POST /api/orders/loop — create a Loop order — ADR 052
import type { Context } from 'hono';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/require-auth.js';
import type { CreateLoopOrderResponse, MerchantDenominations } from '@loop/shared';
import { getMerchants } from '../merchants/sync.js';
import { LoopCreateOrderBody as CreateBody } from './request-schemas.js';
import { getUserCtxUserId } from '../db/users.js';
import { ctxActAsHeaders, provisionCtxUser } from '../ctx/user-provisioning.js';
import { getUserById } from '../db/users.js';
import { ctxFetch, CtxRateLimitedError, CtxUnavailableError } from '../ctx/api-fetch.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import {
  createOrder,
  findOrderByIdempotencyKey,
  recordCtxCreate,
  recordOrderEconomics,
  IdempotentOrderConflictError,
  type Order,
} from './repo.js';
import { markOrderRejected } from './transitions.js';
import {
  CtxGiftCardSchema,
  deriveOrderEconomics,
  fetchCtxCardAsOperator,
  fetchCtxPayment,
  operatorProfitShareBp,
  parseMajorToMinor,
  paymentInstructionsFromCard,
  type CtxGiftCard,
  type CtxPayment,
} from './ctx-order.js';
import { summariseZodIssues } from './handler-shared.js';
import { notifyCtxSchemaDrift, notifyOrderCreated } from '../discord.js';

const log = logger.child({ area: 'loop-orders' });

export const ORDER_MAX_FACE_VALUE_MINOR = 50_000_00n;
export const ORDER_IDEMPOTENCY_KEY_MIN = 16;
export const ORDER_IDEMPOTENCY_KEY_MAX = 128;

const CTX_CREATE_TIMEOUT_MS = 20_000;

export function ctxPaymentCurrencies(): string[] {
  return config.ctx.paymentCurrencies.map((currency) => currency.trim().toUpperCase());
}

// A4-103: exported for tests to pin parsing rules without handler
export function validateMerchantDenomination(
  amountMinor: bigint,
  requestedCurrency: string,
  denominations: MerchantDenominations | undefined,
): string | null {
  if (denominations === undefined) return null;
  if (denominations.currency.toUpperCase() !== requestedCurrency.toUpperCase()) {
    return `currency must be ${denominations.currency} for this merchant`;
  }
  if (denominations.type === 'min-max') {
    const minMinor =
      denominations.min !== undefined ? BigInt(Math.round(denominations.min * 100)) : null;
    const maxMinor =
      denominations.max !== undefined ? BigInt(Math.round(denominations.max * 100)) : null;
    if (minMinor !== null && amountMinor < minMinor) {
      return `amount below merchant minimum (${denominations.min} ${denominations.currency})`;
    }
    if (maxMinor !== null && amountMinor > maxMinor) {
      return `amount above merchant maximum (${denominations.max} ${denominations.currency})`;
    }
    return null;
  }
  if (!Array.isArray(denominations.denominations)) return null;
  const allowedMinor = denominations.denominations
    .map((d) => Number.parseFloat(d))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => BigInt(Math.round(n * 100)));
  if (allowedMinor.length === 0) return null;
  if (allowedMinor.some((m) => m === amountMinor)) return null;
  return `amount must be one of merchant's fixed denominations: ${denominations.denominations.join(', ')} ${denominations.currency}`;
}

function minorToMajor(minor: bigint): string {
  const units = minor / 100n;
  const cents = minor % 100n;
  return `${units.toString()}.${cents.toString().padStart(2, '0')}`;
}

// One awaited attempt; missing mapping is 503, never anonymous operator purchase
async function resolveCtxUserId(userId: string): Promise<string | null> {
  const existing = await getUserCtxUserId(userId);
  if (existing !== null) return existing;
  const user = await getUserById(userId);
  if (user === null || user.email === null) return null;
  try {
    await provisionCtxUser({ id: user.id, email: user.email, ctxUserId: null });
  } catch (err) {
    log.warn({ userId, err }, 'Synchronous CTX provisioning attempt failed');
  }
  return getUserCtxUserId(userId);
}

async function createResponseForOrder(
  order: Order,
  card: CtxGiftCard | null,
  payment: CtxPayment | null,
): Promise<CreateLoopOrderResponse> {
  let resolvedCard = card;
  if (resolvedCard === null && order.ctxOrderId !== null && order.state === 'unpaid') {
    try {
      resolvedCard = await fetchCtxCardAsOperator(order.ctxOrderId);
    } catch (err) {
      log.warn({ orderId: order.id, err }, 'CTX card re-read failed on replay');
    }
  }
  let resolvedPayment = payment;
  const paymentId = resolvedCard?.paymentId ?? order.ctxPaymentId;
  if (resolvedPayment === null && paymentId !== null && paymentId !== undefined) {
    resolvedPayment = await fetchCtxPayment(paymentId);
  }
  const fallback = {
    cryptoCurrency: order.paymentCryptoCurrency ?? '',
    amountMinor: BigInt(order.chargeMinor),
    currency: order.chargeCurrency,
  };
  return {
    orderId: order.id,
    state: order.state as CreateLoopOrderResponse['state'],
    payment:
      resolvedCard !== null
        ? paymentInstructionsFromCard(resolvedCard, resolvedPayment, fallback)
        : {
            ctxPaymentId: order.ctxPaymentId,
            cryptoCurrency: fallback.cryptoCurrency,
            cryptoAmount: null,
            address: null,
            paymentUrls: {},
            amountMinor: order.chargeMinor.toString(),
            currency: order.chargeCurrency,
            expiresAt: null,
          },
  };
}

// Best-effort; failures only log — mirror sweep retries
async function captureOrderEconomics(orderId: string, ctxOrderId: string): Promise<void> {
  try {
    const [card, profitShareBp] = await Promise.all([
      fetchCtxCardAsOperator(ctxOrderId),
      operatorProfitShareBp(),
    ]);
    await recordOrderEconomics(orderId, deriveOrderEconomics(card, profitShareBp));
  } catch (err) {
    log.warn({ orderId, ctxOrderId, err }, 'Operator economics read-back failed — sweep retries');
  }
}

export async function loopCreateOrderHandler(c: Context): Promise<Response> {
  if (!config.auth.native.enabled) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json(
      { code: 'UNAUTHORIZED', message: 'Loop-native authentication required for this endpoint' },
      401,
    );
  }

  const clientId = c.get('clientId') as string | undefined;
  if (clientId === undefined) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'X-Client-Id header required (loopweb / loopios / loopandroid)',
      },
      400,
    );
  }

  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  if (!ctxPaymentCurrencies().includes(parsed.data.cryptoCurrency)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `cryptoCurrency must be one of: ${ctxPaymentCurrencies().join(', ')}`,
      },
      400,
    );
  }

  const idempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key');
  if (idempotencyKey !== undefined) {
    if (
      idempotencyKey.length < ORDER_IDEMPOTENCY_KEY_MIN ||
      idempotencyKey.length > ORDER_IDEMPOTENCY_KEY_MAX
    ) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `Idempotency-Key must be between ${ORDER_IDEMPOTENCY_KEY_MIN} and ${ORDER_IDEMPOTENCY_KEY_MAX} characters`,
        },
        400,
      );
    }
    const prior = await findOrderByIdempotencyKey(auth.userId, idempotencyKey);
    if (prior !== null) {
      return c.json(await createResponseForOrder(prior, null, null), 200);
    }
  }

  if (parsed.data.amountMinor > ORDER_MAX_FACE_VALUE_MINOR) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `amount exceeds maximum order value (${ORDER_MAX_FACE_VALUE_MINOR / 100n} ${parsed.data.currency})`,
      },
      400,
    );
  }

  // Sync job is source of truth; absent merchant is operator-hidden
  const merchant = getMerchants().merchantsById.get(parsed.data.merchantId);
  if (merchant === undefined || merchant.enabled === false) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Unknown or disabled merchant' }, 400);
  }

  const denominationError = validateMerchantDenomination(
    parsed.data.amountMinor,
    parsed.data.currency,
    merchant.denominations,
  );
  if (denominationError !== null) {
    return c.json({ code: 'VALIDATION_ERROR', message: denominationError }, 400);
  }

  const ctxUserId = await resolveCtxUserId(auth.userId);
  if (ctxUserId === null) {
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Your account is still being set up with our supplier — please retry shortly',
      },
      503,
    );
  }
  const actAsHeaders = ctxActAsHeaders(ctxUserId, clientId);
  if (actAsHeaders === null) {
    return c.json(
      { code: 'SERVICE_UNAVAILABLE', message: 'Supplier credentials unavailable' },
      503,
    );
  }

  let order: Order;
  try {
    order = await createOrder({
      userId: auth.userId,
      merchantId: parsed.data.merchantId,
      faceValueMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      paymentCryptoCurrency: parsed.data.cryptoCurrency,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  } catch (err) {
    if (err instanceof IdempotentOrderConflictError) {
      return c.json(await createResponseForOrder(err.existing, null, null), 200);
    }
    throw err;
  }

  let res: Response;
  try {
    res = await ctxFetch(upstreamUrl('/gift-cards'), {
      method: 'POST',
      headers: {
        ...actAsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cryptoCurrency: parsed.data.cryptoCurrency,
        fiatCurrency: parsed.data.currency,
        fiatAmount: minorToMajor(parsed.data.amountMinor),
        merchantId: parsed.data.merchantId,
        operatorReference: order.id,
      }),
      signal: AbortSignal.timeout(CTX_CREATE_TIMEOUT_MS),
    });
  } catch (err) {
    const transient = err instanceof CtxUnavailableError || err instanceof CtxRateLimitedError;
    await markOrderRejected(order.id, transient ? 'supplier unavailable' : 'supplier call failed');
    log.error({ orderId: order.id, err }, 'CTX gift-card create failed');
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to place the order right now' },
      503,
    );
  }

  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    await markOrderRejected(order.id, `supplier rejected create (${res.status})`);
    log.warn(
      { orderId: order.id, status: res.status, body: body.slice(0, 300) },
      'CTX rejected gift-card create',
    );
    if (res.status === 400) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'The supplier rejected this order' }, 400);
    }
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to place the order right now' },
      503,
    );
  }

  const cardParsed = CtxGiftCardSchema.safeParse(await res.json().catch(() => null));
  if (!cardParsed.success) {
    await markOrderRejected(order.id, 'supplier response schema drift');
    notifyCtxSchemaDrift({
      surface: 'POST /gift-cards',
      issuesSummary: summariseZodIssues(cardParsed.error.issues),
    });
    return c.json(
      { code: 'SUPPLIER_UNAVAILABLE', message: 'Unable to place the order right now' },
      503,
    );
  }
  const card = cardParsed.data;

  await recordCtxCreate(order.id, {
    ctxOrderId: card.id,
    ctxPaymentId: card.paymentId ?? null,
    chargeMinor: parseMajorToMinor(card.paymentFiatAmount),
    chargeCurrency: card.paymentFiatCurrency ?? null,
  });

  const payment = card.paymentId !== undefined ? await fetchCtxPayment(card.paymentId) : null;
  void captureOrderEconomics(order.id, card.id);
  notifyOrderCreated({
    orderId: order.id,
    merchantName: merchant.name,
    faceValueMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    cryptoCurrency: parsed.data.cryptoCurrency,
  });

  const updated = { ...order, ctxOrderId: card.id, ctxPaymentId: card.paymentId ?? null };
  return c.json(await createResponseForOrder(updated, card, payment), 201);
}
