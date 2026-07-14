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
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getMerchants } from '../merchants/sync.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { ORDER_PAYMENT_METHODS } from '../db/schema.js';
import { isHomeCurrency, isOrderableCurrency, type CreateLoopOrderResponse } from '@loop/shared';
import { getUserById } from '../db/users.js';
import { convertMinorUnits, CurrencyRateUnavailableError } from '../payments/price-feed.js';
import {
  createOrder,
  findOrderByIdempotencyKey,
  IdempotentOrderConflictError,
  InsufficientCreditError,
} from './repo.js';
import { isFirstLoopAssetOrder } from './loop-create-checks.js';
import { getWalletProvider } from '../wallet/provider.js';
import { buildLoopCreateResponse } from './loop-create-response.js';
import { checkOrderVelocity, VelocityCheckUnavailableError } from '../fraud/velocity.js';

const log = logger.child({ handler: 'loop-orders' });

/**
 * A2-2003: bounds match the admin idempotency contract
 * (`apps/backend/src/admin/idempotency.ts`) — a single mental model
 * for "what shape is an Idempotency-Key" across the API surface.
 */
const ORDER_IDEMPOTENCY_KEY_MIN = 16;
const ORDER_IDEMPOTENCY_KEY_MAX = 128;
/**
 * R3-10 fallback-key window. KNOWN residuals (money review 2026-07-08,
 * accepted): (a) two clicks STRADDLING a bucket boundary derive
 * different keys and both create — the window shrinks the double-click
 * exposure, it doesn't zero it (a true fix is requiring the header,
 * which the loop-native client already sends); (b) a deliberate second
 * identical credit purchase inside the window replays order #1 rather
 * than charging twice — the safe direction for money, mildly
 * surprising for the user. Both strictly better than the pre-R3-10
 * no-guard behaviour.
 */
const CREDIT_FALLBACK_IDEMPOTENCY_BUCKET_MS = 60_000;

/**
 * A4-017: hard ceiling on order face value, in minor units. Defence
 * in depth past the merchant denomination check — most merchants in
 * the catalog declare fixed/min-max denominations and the per-merchant
 * validator rejects out-of-range amounts, but a merchant that ships
 * without `denominations` would otherwise let a hand-crafted POST
 * request a $1M+ order. $50k cap covers the realistic gift-card
 * upper end (high-denomination travel/luxury cards top out around
 * $25k–$50k) without restricting any merchant we've onboarded.
 */
const ORDER_MAX_FACE_VALUE_MINOR = 50_000_00n;

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

function deriveCreditFallbackIdempotencyKey(args: {
  userId: string;
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  bucket: number;
}): string {
  const digest = createHash('sha256')
    .update('loop:r3-10:credit-order-idempotency:v1')
    .update('\0')
    .update(args.userId)
    .update('\0')
    .update(args.merchantId)
    .update('\0')
    .update(args.amountMinor.toString())
    .update('\0')
    .update(args.currency)
    .update('\0')
    .update(args.bucket.toString())
    .digest('hex');
  return `server-credit-v1-${digest.slice(0, 48)}`;
}

function creditFallbackIdempotencyKeys(args: {
  userId: string;
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  nowMs?: number;
}): [string, string] {
  const bucket = Math.floor((args.nowMs ?? Date.now()) / CREDIT_FALLBACK_IDEMPOTENCY_BUCKET_MS);
  return [
    deriveCreditFallbackIdempotencyKey({ ...args, bucket }),
    deriveCreditFallbackIdempotencyKey({ ...args, bucket: bucket - 1 }),
  ];
}

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
  // Defense in depth: a malformed merchant cache entry (CTX schema drift,
  // a hand-edited fixture missing `denominations[]`) used to throw
  // `Cannot read properties of undefined (reading 'map')` here and the
  // global onError caught it as a 500. Fall through to "no denomination
  // contract" rather than crash — the global face-value cap still
  // bounds the amount.
  if (!Array.isArray(denominations.denominations)) return null;
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

  // A2-2003 / R3-10: client-supplied `Idempotency-Key` remains the
  // strongest contract. When absent on `credit` orders, derive a
  // short-window server key from the authenticated user + order body
  // so older clients cannot double-click into two mirror-balance
  // debits. On-chain methods keep the header optional: their duplicate
  // safety is the memo/deposit watcher path, and intentionally buying
  // two identical cards in quick succession must remain possible.
  const suppliedIdempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key');
  let idempotencyKey = suppliedIdempotencyKey;
  let idempotencyLookupKeys: string[] = [];
  if (suppliedIdempotencyKey !== undefined) {
    if (
      suppliedIdempotencyKey.length < ORDER_IDEMPOTENCY_KEY_MIN ||
      suppliedIdempotencyKey.length > ORDER_IDEMPOTENCY_KEY_MAX
    ) {
      return c.json(
        {
          code: 'VALIDATION_ERROR',
          message: `Idempotency-Key must be between ${ORDER_IDEMPOTENCY_KEY_MIN} and ${ORDER_IDEMPOTENCY_KEY_MAX} characters`,
        },
        400,
      );
    }
    idempotencyLookupKeys = [suppliedIdempotencyKey];
  } else if (parsed.data.paymentMethod === 'credit') {
    idempotencyLookupKeys = creditFallbackIdempotencyKeys({
      userId: auth.userId,
      merchantId: parsed.data.merchantId,
      amountMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
    });
    idempotencyKey = idempotencyLookupKeys[0];
  }

  if (idempotencyLookupKeys.length > 0) {
    // Lookup-first: a repeat post short-circuits without holding any
    // locks. The unique index is scoped to (user_id, key), so a key
    // re-used by a different user simply doesn't match here and falls
    // through to the create path.
    for (const lookupKey of idempotencyLookupKeys) {
      const prior = await findOrderByIdempotencyKey(auth.userId, lookupKey);
      if (prior !== null) {
        return await replayOrderResponse(c, prior);
      }
    }
  }

  // ADR 045 (B-3): per-user order-create velocity gate. Runs before
  // any merchant/FX/balance work — it only needs auth.userId — so a
  // user already over budget doesn't pay for work we'd throw away.
  // Only a NEW order attempt reaches here (the idempotency-replay
  // short-circuit above already returned for a repeat request), so
  // this correctly only gates genuinely new orders. See ADR 045 for
  // why this is per-user (not per-IP) and why it fails closed.
  try {
    const velocity = await checkOrderVelocity(auth.userId);
    if (!velocity.allowed) {
      log.warn(
        { userId: auth.userId, reason: velocity.reason, currency: velocity.currency },
        'Order rejected — velocity limit exceeded (ADR 045 / B-3)',
      );
      return c.json(
        {
          code: 'ORDER_VELOCITY_EXCEEDED',
          message:
            velocity.reason === 'value'
              ? `You've reached the maximum order value for a ${env.LOOP_ORDER_VELOCITY_WINDOW_HOURS}-hour period. Please try again later or contact support.`
              : `You've reached the maximum number of orders for a ${env.LOOP_ORDER_VELOCITY_WINDOW_HOURS}-hour period. Please try again later or contact support.`,
        },
        429,
      );
    }
  } catch (err) {
    if (err instanceof VelocityCheckUnavailableError) {
      // Fail CLOSED (ADR 045): a transient DB error must never become
      // a free pass past the fraud gate. No order is created here.
      log.error({ err, userId: auth.userId }, 'Order velocity check unavailable — failing closed');
      return c.json(
        {
          code: 'ORDER_VELOCITY_CHECK_UNAVAILABLE',
          message: 'Unable to verify order velocity right now — please try again shortly',
        },
        503,
      );
    }
    throw err;
  }

  // A4-017: global face-value ceiling. Caught here before we do any
  // merchant/FX/balance work so a malformed bigint request can't
  // burn cycles or upstream calls.
  if (parsed.data.amountMinor > ORDER_MAX_FACE_VALUE_MINOR) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `amount exceeds maximum order value (${ORDER_MAX_FACE_VALUE_MINOR / 100n} ${parsed.data.currency})`,
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
  // CF-19 (ADR 035): accept the three cashback home currencies AND the
  // extended display markets (AED/INR/SAR/AUD/MXN). The gift-card
  // currency is the *catalog* currency — distinct from the user's
  // cashback home currency, which stays USD/GBP/EUR (extended markets
  // are display-only, no LOOP asset). An extended-market card is
  // FX-pinned to the user's home currency below, so `orders.currency`
  // may be extended but `orders.charge_currency` is always a home
  // currency. Validate against the orderable-currency set, NOT
  // `isHomeCurrency` (which is the cashback/ledger set).
  if (!isOrderableCurrency(parsed.data.currency)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'Unsupported gift-card currency',
      },
      400,
    );
  }

  // FX-pin the user's charge. Same-currency short-circuits (no feed
  // hit); cross-currency calls through to the Frankfurter cache in
  // price-feed.ts. Two distinct failure modes are surfaced cleanly so
  // an order is NEVER created with a wrong charge:
  //   - CF-19: an extended-market currency the external rates service
  //     doesn't serve yet → CURRENCY_NOT_AVAILABLE ("coming soon"). The
  //     market is SEO-promoted but not yet buyable; this is a clean,
  //     specific signal, not a crash. Goes away when rates serves it.
  //   - A genuine FX feed outage for a supported currency → 503
  //     SERVICE_UNAVAILABLE (retryable).
  let chargeMinor: bigint;
  try {
    chargeMinor = await convertMinorUnits(
      parsed.data.amountMinor,
      parsed.data.currency,
      user.homeCurrency,
    );
  } catch (err) {
    if (err instanceof CurrencyRateUnavailableError) {
      log.warn(
        { userId: auth.userId, currency: parsed.data.currency },
        'extended-market order rejected — no live rate for currency yet (CF-19)',
      );
      return c.json(
        {
          code: 'CURRENCY_NOT_AVAILABLE',
          message: 'Ordering for this market is coming soon',
        },
        503,
      );
    }
    log.error({ err, userId: auth.userId }, 'FX conversion failed at order creation');
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'FX rate temporarily unavailable',
      },
      503,
    );
  }

  // ADR 036 open question 3 — RESOLVED 2026-06-12 (Ash): the
  // authority is the tokens the user holds, not the mirror — "their
  // balance should just be whatever tokens they have". Once a user's
  // embedded wallet is `activated` (and the wallet layer is on), all
  // accrued cashback is emitted on-chain and spending happens as
  // token redemption (`loop_asset` / POST /api/orders/loop/:id/redeem),
  // which extinguishes BOTH halves (mirror debit + issuer-return
  // burn). The `credit` method — an inline mirror debit with no token
  // movement — is RETIRED for those users: allowing it would drain
  // the mirror while the matching tokens stay spendable (the A4-110
  // double-spend, now scoped precisely to the emitted balance).
  //
  // Users NOT yet activated are the migration window: their mirror
  // balance accrued pre-wallet and no tokens have been emitted for
  // it, so the inline mirror debit is the only coherent spend path —
  // `credit` keeps working for them until provisioning + payout
  // draining completes.
  if (parsed.data.paymentMethod === 'credit') {
    const walletLayerOn = getWalletProvider() !== null;
    if (walletLayerOn && user.walletProvisioning === 'activated') {
      log.info(
        { userId: auth.userId, merchantId: parsed.data.merchantId },
        'credit-method order rejected — wallet activated, credit method retired (ADR 036 OQ3)',
      );
      return c.json(
        {
          code: 'CREDIT_METHOD_RETIRED',
          message:
            'The credit payment method is retired for wallet-enabled accounts. Pay with your Loop balance instead — it redeems your LOOP tokens (POST /api/orders/loop/:id/redeem).',
        },
        400,
      );
    }
  }

  // AUDIT-2 finding B (2026-07 hardening): `loop_asset` is a Phase-2
  // spend surface — token redemption assumes wallet provisioning +
  // an on-chain LOOP balance, both Phase-2 UI. Before this gate,
  // nothing server-side stopped a direct API caller who already had
  // (or acquired) a provisioned wallet with a nonzero LOOP balance
  // from creating and redeeming a loop_asset order at full face
  // value in production, where LOOP_WORKERS_ENABLED=true coexists
  // with LOOP_PHASE_1_ONLY=true (fly.toml) — only zero balances +
  // the client's UI hardcode held the line, both incidental rather
  // than structural. Mirrors the `credit`/CREDIT_METHOD_RETIRED gate
  // above: a clean, explicit rejection instead of relying on the
  // absence of funded wallets. Does NOT gate `credit`/`xlm`/`usdc` —
  // those keep working exactly as today in both phases.
  if (parsed.data.paymentMethod === 'loop_asset' && env.LOOP_PHASE_1_ONLY) {
    log.info(
      { userId: auth.userId, merchantId: parsed.data.merchantId },
      'loop_asset order rejected — LOOP_PHASE_1_ONLY gate (AUDIT-2 finding B)',
    );
    return c.json(
      {
        code: 'LOOP_ASSET_UNAVAILABLE_PHASE_1',
        message:
          'Paying with your Loop balance is not available yet. Use a card, XLM, or USDC payment method instead.',
      },
      400,
    );
  }

  // XLM / USDC / loop_asset orders need a configured deposit
  // address; without one the watcher has nowhere to see payments,
  // so we must reject before writing the row (the row's memo
  // would be written but orphaned). `credit` orders skip this —
  // nothing is sent on-chain; the mirror debit settles them.
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
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    return await buildLoopCreateResponse(c, {
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
      return await replayOrderResponse(c, err.existing);
    }
    // Insufficient balance caught by the FOR UPDATE re-read inside
    // `createOrder`'s credit txn (A2-601 guard) — the sole balance
    // check on this path. No order row was persisted (txn rolled
    // back), so this surfaces as a clean 400 the client can handle.
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
