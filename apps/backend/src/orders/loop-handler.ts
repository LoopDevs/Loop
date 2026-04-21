/**
 * Loop-native order creation (ADR 010).
 *
 * `POST /api/orders/loop` — the entry point for the principal-switch
 * flow. Accepts a merchantId + amount + payment method from a
 * Loop-authenticated user, pins the cashback split via the repo,
 * writes a `pending_payment` row, and returns payment instructions
 * the client can act on (XLM / USDC deposit address + memo, or just
 * the order id for credit-funded orders).
 *
 * Gated behind `LOOP_AUTH_NATIVE_ENABLED`. When the flag is off the
 * handler returns 404 — there is no Loop-native order flow yet and
 * the legacy CTX-proxy `/api/orders` is the live surface.
 *
 * Auth: only accepts `auth.kind === 'loop'` bearers. A legacy CTX
 * bearer reaching this endpoint means the client hasn't rotated
 * through ADR 013's Phase B yet — we reject so the client refreshes
 * into a Loop-native session before placing an order under the new
 * flow.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, userCredits } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { ORDER_PAYMENT_METHODS, type OrderPaymentMethod } from '../db/schema.js';
import { createOrder } from './repo.js';

const log = logger.child({ handler: 'loop-orders' });

const CreateBody = z.object({
  merchantId: z.string().min(1),
  /** Face value the user pays for / the gift card is worth, in minor units. */
  amountMinor: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
    .transform((v) => BigInt(v)),
  /** ISO 4217 3-letter code. */
  currency: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase()),
  paymentMethod: z.enum(ORDER_PAYMENT_METHODS),
});

export interface OrderPaymentResponse {
  orderId: string;
  payment:
    | {
        method: Extract<OrderPaymentMethod, 'xlm' | 'usdc'>;
        stellarAddress: string;
        memo: string;
        amountMinor: string;
        currency: string;
      }
    | {
        method: 'credit';
        amountMinor: string;
        currency: string;
      };
}

/**
 * Verifies the user has at least `amountMinor` in `currency`. Returns
 * true when the balance covers the order. Called for credit-funded
 * orders before writing the row — the actual debit happens later on
 * payment watcher transition, inside the same txn as the state move
 * to `paid`.
 */
async function hasSufficientCredit(
  userId: string,
  currency: string,
  amountMinor: bigint,
): Promise<boolean> {
  const row = await db
    .select({ balance: sql<string>`${userCredits.balanceMinor}::text` })
    .from(userCredits)
    .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, currency)));
  const balanceStr = row[0]?.balance ?? '0';
  return BigInt(balanceStr) >= amountMinor;
}

export async function loopCreateOrderHandler(c: Context): Promise<Response> {
  if (!env.LOOP_AUTH_NATIVE_ENABLED) {
    // Mirror the admin handler's 404 policy — don't leak that the
    // surface exists yet while the feature flag is off.
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json(
      {
        code: 'UNAUTHORIZED',
        message: 'Loop-native authentication required for this endpoint',
      },
      401,
    );
  }

  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  // Validate the merchant exists + is enabled in the in-memory cache.
  // We don't round-trip to CTX here — the sync job is our source of
  // truth; a merchant absent from cache is one the operator has
  // already decided to hide, and placing an order for it is a bug.
  const merchant = getMerchants().merchantsById.get(parsed.data.merchantId);
  if (merchant === undefined || merchant.enabled === false) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Unknown or disabled merchant' }, 400);
  }

  // Credit-funded orders need an upfront balance check. XLM / USDC
  // orders are funded externally — the payment watcher performs the
  // credit before transitioning to `paid`, so we don't need a
  // balance check here.
  if (parsed.data.paymentMethod === 'credit') {
    const ok = await hasSufficientCredit(
      auth.userId,
      parsed.data.currency,
      parsed.data.amountMinor,
    );
    if (!ok) {
      return c.json(
        {
          code: 'INSUFFICIENT_CREDIT',
          message: 'Loop credit balance is below the order amount',
        },
        400,
      );
    }
  }

  // XLM / USDC orders need a configured deposit address; without one
  // the watcher has nowhere to see payments, so we must reject before
  // writing the row (the row's memo would be written but orphaned).
  if (parsed.data.paymentMethod !== 'credit' && env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
    log.error('LOOP_STELLAR_DEPOSIT_ADDRESS unset — refusing on-chain order');
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'On-chain payment temporarily unavailable',
      },
      503,
    );
  }

  try {
    const order = await createOrder({
      userId: auth.userId,
      merchantId: parsed.data.merchantId,
      faceValueMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      paymentMethod: parsed.data.paymentMethod,
    });
    const base = {
      orderId: order.id,
    };
    if (order.paymentMethod === 'credit') {
      return c.json<OrderPaymentResponse>({
        ...base,
        payment: {
          method: 'credit',
          amountMinor: order.faceValueMinor.toString(),
          currency: order.currency,
        },
      });
    }
    // xlm / usdc — both use Stellar as the rail. LOOP_STELLAR_DEPOSIT_ADDRESS
    // was validated above.
    return c.json<OrderPaymentResponse>({
      ...base,
      payment: {
        method: order.paymentMethod as 'xlm' | 'usdc',
        stellarAddress: env.LOOP_STELLAR_DEPOSIT_ADDRESS!,
        memo: order.paymentMemo ?? '',
        amountMinor: order.faceValueMinor.toString(),
        currency: order.currency,
      },
    });
  } catch (err) {
    log.error({ err, userId: auth.userId }, 'Loop-native order creation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
}

export interface LoopOrderView {
  id: string;
  merchantId: string;
  state: string;
  faceValueMinor: string;
  currency: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit';
  /** Populated when state ≥ pending_payment and the method is on-chain. */
  paymentMemo: string | null;
  /** Loop's deposit address for the configured env. Always populated for on-chain orders. */
  stellarAddress: string | null;
  userCashbackMinor: string;
  /** CTX gift-card id, populated once procurement resolves. */
  ctxOrderId: string | null;
  /** Redemption payload (ADR 010). Null fields when CTX didn't return them. */
  redeemCode: string | null;
  redeemPin: string | null;
  redeemUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/**
 * GET /api/orders/loop/:id
 *
 * Returns the Loop-native order the caller owns. 404 on non-owner
 * reads to avoid leaking existence — the order belongs to exactly
 * one Loop user, keyed on the JWT `sub`.
 *
 * Response shape is BigInt-safe — all integer columns serialise as
 * strings. Timestamps are ISO-8601.
 */
export async function loopGetOrderHandler(c: Context): Promise<Response> {
  if (!env.LOOP_AUTH_NATIVE_ENABLED) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }

  const row = await db.query.orders.findFirst({
    where: and(eq(orders.id, id), eq(orders.userId, auth.userId)),
  });
  if (row === undefined || row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }

  const view: LoopOrderView = {
    id: row.id,
    merchantId: row.merchantId,
    state: row.state,
    faceValueMinor: row.faceValueMinor.toString(),
    currency: row.currency,
    paymentMethod: row.paymentMethod as 'xlm' | 'usdc' | 'credit',
    paymentMemo: row.paymentMemo,
    stellarAddress:
      row.paymentMethod === 'credit' ? null : (env.LOOP_STELLAR_DEPOSIT_ADDRESS ?? null),
    userCashbackMinor: row.userCashbackMinor.toString(),
    ctxOrderId: row.ctxOrderId,
    redeemCode: row.redeemCode,
    redeemPin: row.redeemPin,
    redeemUrl: row.redeemUrl,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
  return c.json(view);
}
