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
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { ORDER_PAYMENT_METHODS } from '../db/schema.js';
import { isHomeCurrency, type CreateLoopOrderResponse } from '@loop/shared';
import { getUserById } from '../db/users.js';
import { convertMinorUnits } from '../payments/price-feed.js';
import {
  createOrder,
  findOrderByIdempotencyKey,
  IdempotentOrderConflictError,
  InsufficientCreditError,
} from './repo.js';
import { isFirstLoopAssetOrder } from './loop-create-checks.js';
import { buildLoopCreateResponse } from './loop-create-response.js';

const log = logger.child({ handler: 'loop-orders' });

/**
 * A2-2003: bounds match the admin idempotency contract
 * (`apps/backend/src/admin/idempotency.ts`) — a single mental model
 * for "what shape is an Idempotency-Key" across the API surface.
 */
const ORDER_IDEMPOTENCY_KEY_MIN = 16;
const ORDER_IDEMPOTENCY_KEY_MAX = 128;

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

/**
 * A2-1504: wire response type is now canonical in `@loop/shared`
 * (`CreateLoopOrderResponse`). Re-export the legacy name so callers
 * don't need to rename in the same PR that unified the contract.
 */
export type OrderPaymentResponse = CreateLoopOrderResponse;

// `replayOrderResponse` (A2-2003 idempotent-replay shaper) lives in
// `./loop-replay-response.ts`. Imported back here for the two
// in-handler call sites.
import { replayOrderResponse } from './loop-replay-response.js';

/**
 * A4-103: validate the requested amount against the merchant's
 * denomination contract from the synced catalog. Pure / exported so
 * tests can pin the parsing rules without going through the
 * handler.
 *
 * Returns null when valid, or a user-facing message when the amount
 * is out-of-range or a fixed-denomination merchant rejects the
 * value. Currency mismatch falls through (merchant catalog currency
 * differs from the user's home currency at FX-pinning time, which
 * the handler already converts).
 *
 * `denominations.denominations[]` is a string array of major-unit
 * decimal values (e.g. "10", "25.00") — parse to minor-unit
 * comparison via `Math.round(major * 100)` to avoid float drift.
 */
import type { MerchantDenominations } from '@loop/shared';
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
  // Fixed-denomination: amount must match one of the configured values.
  const allowedMinor = denominations.denominations
    .map((d) => Number.parseFloat(d))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => BigInt(Math.round(n * 100)));
  if (allowedMinor.length === 0) return null;
  if (allowedMinor.some((m) => m === amountMinor)) return null;
  return `amount must be one of merchant's fixed denominations: ${denominations.denominations.join(', ')} ${denominations.currency}`;
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

  // A2-2003: optional `Idempotency-Key` header. When present and well-
  // formed, a repeat post within the row's lifetime returns the
  // already-created order's response instead of writing a second row
  // (and, for credit-funded orders, a second `user_credits` debit).
  // When absent, the legacy double-click risk is preserved — the
  // header is opt-in for now while the loop-native client rolls out.
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
    // Lookup-first: a repeat post short-circuits without holding any
    // locks. The unique index is scoped to (user_id, key), so a key
    // re-used by a different user simply doesn't match here and falls
    // through to the create path.
    const prior = await findOrderByIdempotencyKey(auth.userId, idempotencyKey);
    if (prior !== null) {
      return replayOrderResponse(c, prior);
    }
  }

  // Validate the merchant exists + is enabled in the in-memory cache.
  // We don't round-trip to CTX here — the sync job is our source of
  // truth; a merchant absent from cache is one the operator has
  // already decided to hide, and placing an order for it is a bug.
  const merchant = getMerchants().merchantsById.get(parsed.data.merchantId);
  if (merchant === undefined || merchant.enabled === false) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Unknown or disabled merchant' }, 400);
  }

  // A4-103: enforce merchant min/max/fixed denomination limits
  // server-side. The web client gates the amount-input UX
  // (AmountSelection.tsx), but a hand-crafted POST can pass any
  // amount through, including a face value the merchant doesn't
  // support — we'd then place the CTX wholesale purchase blind on
  // an unsupported denomination, which CTX may reject mid-flow
  // after the user has already paid. The merchant cache is the
  // source of truth (synced from upstream catalog).
  const denominationError = validateMerchantDenomination(
    parsed.data.amountMinor,
    parsed.data.currency,
    merchant.denominations,
  );
  if (denominationError !== null) {
    return c.json({ code: 'VALIDATION_ERROR', message: denominationError }, 400);
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

  // A4-110 (b): credit-method spend drains user_credits without
  // requiring inbound on-chain LOOP-asset, contradicting the
  // redemption-rule confirmed 2026-05-03 ("to spend cashback the
  // user must send their on-chain LOOP back to Loop"). Off-chain
  // user_credits is fungible across all positive sources
  // (cashback, refund, adjustment, interest); the credit-method
  // path can therefore drain the cashback-tagged portion of the
  // balance even though the user is still holding the matching
  // on-chain LOOP-asset, which they could then spend separately
  // via loop_asset method or via withdrawal.
  //
  // The proper fix requires bucketing user_credits into
  // "cashback-source" (redeemable only via on-chain return) vs
  // "non-cashback-source" (refund/adjustment/interest, drainable
  // via credit method). That's a schema-level migration tracked
  // separately. Until then, reject `paymentMethod='credit'`
  // entirely so the redemption rule is held strictly:
  //   - cashback → user receives on-chain LOOP → spends via
  //     loop_asset (which now debits user_credits, A4-110 a)
  //   - non-cashback credit (refunds, adjustments) → currently
  //     un-redeemable through the order surface; ops handles
  //     manually until the bucketing design lands.
  //
  // The web UI already hardcodes paymentMethod='usdc' (A4-121),
  // so no shipping client breaks. The CRITICAL_DOUBLE_SPEND
  // error code makes the gate explicit so a staging environment
  // that tries credit-method gets a clear signal.
  if (parsed.data.paymentMethod === 'credit') {
    log.warn(
      { userId: auth.userId, merchantId: parsed.data.merchantId },
      'credit-method order rejected pending A4-110(b) cashback/refund credit-source bucketing',
    );
    return c.json(
      {
        code: 'PAYMENT_METHOD_DISABLED',
        message:
          'credit-method spend is temporarily disabled. Use loop_asset (send your LOOP-asset to the deposit address) to spend cashback.',
      },
      400,
    );
  }

  // XLM / USDC / loop_asset orders need a configured deposit
  // address; without one the watcher has nowhere to see payments,
  // so we must reject before writing the row (the row's memo
  // would be written but orphaned). With A4-110(b) the credit
  // method is rejected upstream, so the only remaining methods
  // here are on-chain.
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
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
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    return buildLoopCreateResponse(c, {
      order,
      userId: user.id,
      homeCurrency: user.homeCurrency,
      merchant,
      firstLoopAsset,
    });
  } catch (err) {
    // A2-2003: a concurrent request raced us through the lookup-first
    // path (e.g. parallel double-clicks dispatched in flight before
    // the first INSERT committed). The unique-violation rolled the
    // failing txn back; replay the prior order's response.
    if (err instanceof IdempotentOrderConflictError) {
      return replayOrderResponse(c, err.existing);
    }
    // Balance race between `hasSufficientCredit` check and the FOR
    // UPDATE debit inside `createOrder` (A2-601 guard). No order
    // row was persisted (txn rolled back), so the UX is the same as
    // the pre-check failure — a 400 the client can surface.
    if (err instanceof InsufficientCreditError) {
      return c.json(
        { code: 'INSUFFICIENT_CREDIT', message: 'Loop credit balance is below the order amount' },
        400,
      );
    }
    log.error({ err, userId: auth.userId }, 'Loop-native order creation failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to create order' }, 500);
  }
}

// Loop-native order READ handlers (`GET /api/orders/loop` list +
// `GET /api/orders/loop/:id` detail) live in
// `./loop-read-handlers.ts`. Re-exported here so the routes module's
// existing import block keeps working without re-targeting; the
// `LoopOrderView` type is also re-exported because handler tests +
// shared client code reference it.
export {
  loopGetOrderHandler,
  loopListOrdersHandler,
  type LoopOrderView,
} from './loop-read-handlers.js';
