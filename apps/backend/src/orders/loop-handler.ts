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
import {
  ORDER_PAYMENT_METHODS,
  HOME_CURRENCIES,
  type OrderPaymentMethod,
  type HomeCurrency,
} from '../db/schema.js';
import { getUserById } from '../db/users.js';
import { convertMinorUnits } from '../payments/price-feed.js';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { notifyCashbackRecycled, notifyFirstCashbackRecycled } from '../discord.js';
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
        method: 'loop_asset';
        stellarAddress: string;
        memo: string;
        amountMinor: string;
        currency: string;
        /** The LOOP asset code + issuer the user should send. Pinned to home_currency. */
        assetCode: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
        assetIssuer: string;
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

/**
 * True when the user has zero prior loop_asset orders (any state).
 * Used to distinguish the first-recycle milestone from ongoing
 * recycling, so `notifyFirstCashbackRecycled` only fires once per
 * user. LIMIT 1 so the query is constant-time regardless of how
 * much loop_asset volume the user has accumulated.
 */
async function isFirstLoopAssetOrder(userId: string): Promise<boolean> {
  const row = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.paymentMethod, 'loop_asset')))
    .limit(1);
  return row.length === 0;
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

  // ADR 015: resolve the user's home currency so we can pin the
  // charge alongside the gift-card value. Loop-native auth carries
  // a resolved userId on the JWT, so this is a single-row lookup.
  const user = await getUserById(auth.userId);
  if (user === null) {
    log.warn({ userId: auth.userId }, 'Loop-auth userId has no matching users row');
    return c.json({ code: 'UNAUTHORIZED', message: 'User record not found' }, 401);
  }
  if (!isHomeCurrency(user.homeCurrency)) {
    // users.home_currency has a CHECK constraint at the DB layer; hitting
    // this means schema drift or a hand-edited row. Fail closed so a
    // corrupt row doesn't silently skip FX pinning.
    log.error(
      { userId: user.id, homeCurrency: user.homeCurrency },
      'User home_currency is not in the supported enum',
    );
    return c.json({ code: 'INTERNAL_ERROR', message: 'Invalid account currency' }, 500);
  }
  if (!isHomeCurrency(parsed.data.currency)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'currency must be USD, GBP, or EUR',
      },
      400,
    );
  }

  // FX-pin the user's charge. Same-currency short-circuits (no feed
  // hit); cross-currency calls through to the Frankfurter cache in
  // price-feed.ts. A feed failure bubbles as a 503 rather than
  // silently charging the wrong amount.
  let chargeMinor: bigint;
  try {
    chargeMinor = await convertMinorUnits(
      parsed.data.amountMinor,
      parsed.data.currency,
      user.homeCurrency,
    );
  } catch (err) {
    log.error({ err, userId: auth.userId }, 'FX conversion failed at order creation');
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'FX rate temporarily unavailable',
      },
      503,
    );
  }

  // Credit-funded orders need an upfront balance check against the
  // user's home-currency balance (the ledger is home-currency keyed,
  // ADR 015). The actual debit happens on the `paid` transition.
  if (parsed.data.paymentMethod === 'credit') {
    const ok = await hasSufficientCredit(auth.userId, user.homeCurrency, chargeMinor);
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

  // Compute the "is this user's first loop_asset order?" flag
  // BEFORE the insert — querying post-insert would always see the
  // just-created row and never be true. A race with a concurrent
  // loop_asset insert would fire two "first" notifications; the
  // signal is a flywheel-milestone celebration rather than a hard
  // constraint, so a rare double-fire is tolerable. No-op for
  // non-loop_asset payment methods.
  const firstLoopAsset =
    parsed.data.paymentMethod === 'loop_asset' ? await isFirstLoopAssetOrder(auth.userId) : false;

  try {
    const order = await createOrder({
      userId: auth.userId,
      merchantId: parsed.data.merchantId,
      faceValueMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      chargeMinor,
      chargeCurrency: user.homeCurrency,
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
          // Charge the user pays, in their home currency — matches
          // what the UI renders on the "confirm order" screen.
          amountMinor: order.chargeMinor.toString(),
          currency: order.chargeCurrency,
        },
      });
    }
    if (order.paymentMethod === 'loop_asset') {
      // ADR 015 — user is paying with a LOOP-branded asset matching
      // their home currency. Surface the asset code + issuer so the
      // client's Stellar tx builder can construct the payment against
      // the correct `{code, issuer}` pair.
      const payoutAsset = payoutAssetFor(user.homeCurrency);
      if (payoutAsset.issuer === null) {
        // The issuer env isn't set for this currency. We already
        // wrote the order row; roll back isn't worth the complexity
        // here since the row will hit the 24h expiry sweep. Log and
        // 503 so the client can retry later.
        log.error(
          { homeCurrency: user.homeCurrency, assetCode: payoutAsset.code },
          'loop_asset order placed but matching issuer env var not set',
        );
        return c.json(
          {
            code: 'SERVICE_UNAVAILABLE',
            message: 'LOOP asset not configured for your region',
          },
          503,
        );
      }
      // ADR 015 flywheel signal — a user is paying with LOOP asset
      // cashback they previously earned. Co-located with the response
      // rather than post-fulfillment because the signal is about
      // intent (user opted into the rail) not outcome (order cleared);
      // a failed loop_asset order still demonstrates flywheel intent
      // and ops wants to see that in #loop-orders. Fire-and-forget.
      notifyCashbackRecycled({
        orderId: order.id,
        merchantName: merchant.name,
        amount: Number(order.faceValueMinor) / 100,
        currency: order.currency,
        assetCode: payoutAsset.code,
      });
      if (firstLoopAsset) {
        // Milestone alert: this user has just graduated from
        // earning cashback to spending it. Fire-and-forget;
        // catalog entry in DISCORD_NOTIFIERS.
        notifyFirstCashbackRecycled({
          orderId: order.id,
          userId: user.id,
          userEmail: user.email,
          merchantName: merchant.name,
          amount: Number(order.faceValueMinor) / 100,
          currency: order.currency,
          assetCode: payoutAsset.code,
        });
      }
      return c.json<OrderPaymentResponse>({
        ...base,
        payment: {
          method: 'loop_asset',
          stellarAddress: env.LOOP_STELLAR_DEPOSIT_ADDRESS!,
          memo: order.paymentMemo ?? '',
          amountMinor: order.chargeMinor.toString(),
          currency: order.chargeCurrency,
          assetCode: payoutAsset.code,
          assetIssuer: payoutAsset.issuer,
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
        amountMinor: order.chargeMinor.toString(),
        currency: order.chargeCurrency,
      },
    });
  } catch (err) {
    log.error({ err, userId: auth.userId }, 'Loop-native order creation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
}

/**
 * Narrow a DB-read string into the `HomeCurrency` union. Guards the
 * handler from a schema-drifted `users.home_currency` row sneaking
 * past the convertMinorUnits typed parameter.
 */
function isHomeCurrency(s: string): s is HomeCurrency {
  return (HOME_CURRENCIES as ReadonlyArray<string>).includes(s);
}

export interface LoopOrderView {
  id: string;
  merchantId: string;
  state: string;
  /** Gift-card face value, in the catalog currency (ADR 015). */
  faceValueMinor: string;
  /** Catalog currency the gift card is denominated in. */
  currency: string;
  /**
   * What the user was charged, in their home currency. For orders
   * where home_currency === catalog currency (every pre-ADR-015
   * order), this mirrors `faceValueMinor` + `currency`.
   */
  chargeMinor: string;
  chargeCurrency: string;
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
 * Shapes a DB `orders` row into the BigInt-safe wire view. Shared by
 * the single-get and list handlers so their response shapes match.
 */
function orderToView(row: {
  id: string;
  merchantId: string;
  state: string;
  faceValueMinor: bigint;
  currency: string;
  chargeMinor: bigint;
  chargeCurrency: string;
  paymentMethod: string;
  paymentMemo: string | null;
  userCashbackMinor: bigint;
  ctxOrderId: string | null;
  redeemCode: string | null;
  redeemPin: string | null;
  redeemUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  failedAt: Date | null;
}): LoopOrderView {
  return {
    id: row.id,
    merchantId: row.merchantId,
    state: row.state,
    faceValueMinor: row.faceValueMinor.toString(),
    currency: row.currency,
    chargeMinor: row.chargeMinor.toString(),
    chargeCurrency: row.chargeCurrency,
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

  return c.json(orderToView(row));
}

/**
 * GET /api/orders/loop
 *
 * Owner-scoped list of the caller's Loop-native orders, newest first.
 * Supports `?limit=<n>` (1–100, default 50). Pagination by
 * `?before=<iso>` — the list is descending by `created_at`, so a
 * client paging backwards passes the last row's createdAt.
 *
 * Returns `{ orders: LoopOrderView[] }`. An empty list is a valid
 * response (fresh accounts / no Loop-native orders yet).
 */
export async function loopListOrdersHandler(c: Context): Promise<Response> {
  if (!env.LOOP_AUTH_NATIVE_ENABLED) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }

  const limitRaw = c.req.query('limit');
  const parsedLimit = Number.parseInt(limitRaw ?? '50', 10);
  // Unparseable input → default (50); a parseable 0 or negative
  // clamps to the floor (1); >100 clamps to the ceiling.
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 100);
  const before = c.req.query('before');
  const beforeDate = typeof before === 'string' && before.length > 0 ? new Date(before) : null;
  if (beforeDate !== null && Number.isNaN(beforeDate.getTime())) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'before must be an ISO-8601 timestamp' },
      400,
    );
  }

  const rows = await db
    .select()
    .from(orders)
    .where(
      beforeDate !== null
        ? and(eq(orders.userId, auth.userId), sql`${orders.createdAt} < ${beforeDate}`)
        : eq(orders.userId, auth.userId),
    )
    .orderBy(sql`${orders.createdAt} DESC`)
    .limit(limit);

  return c.json({ orders: rows.map(orderToView) });
}
