/**
 * Loop-native order read handlers — `GET /api/orders/loop/:id`
 * + `GET /api/orders/loop` (ADR 010).
 *
 * Lifted out of `apps/backend/src/orders/loop-handler.ts`. Two
 * caller-scoped reads that share the `orderToView` shaper:
 *
 *   - `loopGetOrderHandler` — owner-scoped single-order detail.
 *     404 on non-owner reads to avoid leaking existence.
 *   - `loopListOrdersHandler` — owner-scoped paginated list,
 *     newest-first, `?limit=` clamped 1-100, `?before=<iso>` for
 *     descending pagination.
 *
 * Both gate on `LOOP_AUTH_NATIVE_ENABLED` (404 when off) and
 * require an `auth.kind === \'loop\'` bearer (401 otherwise).
 *
 * The `orderToView` BigInt-safe shaper lives here because the two
 * read handlers are its only consumers — the create handler in
 * `./loop-handler.ts` returns its own create-time response shape
 * via `replayOrderResponse`, not through `orderToView`.
 */
import type { Context } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { type OrderPaymentMethod } from '../db/schema.js';
import { type LoopOrderView as SharedLoopOrderView } from '@loop/shared';
import { decryptRedeemField, RedeemDecryptError } from './redeem-crypto.js';
import { deriveLoopPaymentInstructions } from './loop-payment-instructions.js';

/**
 * Terminal states carry no live payment guidance (nothing left to pay).
 * Q6-4b: `loopGetOrderHandler` skips the oracle re-quote for these — both
 * a cost saving on the polled-to-fulfillment hot path and the correct
 * semantics (a fulfilled/failed/expired order has no pay screen to resume).
 */
function isTerminalOrderState(state: string): boolean {
  return state === 'fulfilled' || state === 'failed' || state === 'expired';
}

const log = logger.child({ area: 'loop-order-reads' });

/**
 * CF-25 / X-PRIV-03: decrypt a stored redeem secret for the owner-
 * scoped read. Legacy plaintext rows pass through untouched. A decrypt
 * failure (tampered ciphertext, or the key was rotated away / unset
 * after a row was encrypted) returns null + logs — the order still
 * renders, the field reads as "redemption unavailable", and we never
 * serve a forged/unverifiable code. The order id is safe to log; the
 * code/PIN never is.
 */
function readRedeemField(
  orderId: string,
  field: 'code' | 'pin',
  stored: string | null,
): string | null {
  try {
    return decryptRedeemField(stored);
  } catch (err) {
    if (err instanceof RedeemDecryptError) {
      log.error({ orderId, field }, 'Failed to decrypt redeem field — serving null');
      return null;
    }
    throw err;
  }
}

/**
 * A2-1504: wire view type is now canonical in `@loop/shared`
 * (`LoopOrderView`). Re-export under the historical name to keep
 * the handler's public surface stable.
 *
 * The shared view also widens `paymentMethod` to include `loop_asset`
 * — the DB column holds it and the UI reads it
 * (`LoopOrdersList.tsx:84`), so the prior local cast to
 * `'xlm' | 'usdc' | 'credit'` was a silent narrowing.
 */
export type LoopOrderView = SharedLoopOrderView;

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
    // DB CHECK constraint `orders_state_known` (ADR 010) is the
    // runtime gate; the cast here tells TS that what comes out of
    // the column is one of the `OrderState` variants.
    state: row.state as SharedLoopOrderView['state'],
    faceValueMinor: row.faceValueMinor.toString(),
    currency: row.currency,
    chargeMinor: row.chargeMinor.toString(),
    chargeCurrency: row.chargeCurrency,
    // DB CHECK constraint `orders_payment_method_known` pins the
    // column to `ORDER_PAYMENT_METHODS`. A2-1504 widened this from
    // `'xlm' | 'usdc' | 'credit'` because `loop_asset` rows do reach
    // this path (recycled cashback — ADR 015) and the UI keys off it.
    paymentMethod: row.paymentMethod as OrderPaymentMethod,
    paymentMemo: row.paymentMemo,
    stellarAddress:
      row.paymentMethod === 'credit' ? null : (env.LOOP_STELLAR_DEPOSIT_ADDRESS ?? null),
    // Q6-4b: server-derived payment-guidance fields. Default null here;
    // `loopGetOrderHandler` overlays them for a single, non-terminal,
    // on-chain order (see below). The list handler leaves them null — it
    // never renders pay instructions, and re-quoting the oracle per row
    // would be wasteful.
    assetAmount: null,
    paymentUri: null,
    assetCode: null,
    assetIssuer: null,
    userCashbackMinor: row.userCashbackMinor.toString(),
    ctxOrderId: row.ctxOrderId,
    // CF-25 / X-PRIV-03: code + PIN are envelope-encrypted at rest;
    // decrypt for the owner here. Legacy plaintext passes through.
    redeemCode: readRedeemField(row.id, 'code', row.redeemCode),
    redeemPin: readRedeemField(row.id, 'pin', row.redeemPin),
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

  const view = orderToView(row);

  // Q6-4b: server-authoritative payment guidance. For a non-terminal,
  // on-chain order, re-derive the asset amount + SEP-7 deep-link from the
  // server-authoritative order row (the SAME derivation the idempotent-POST
  // replay uses — deriveLoopPaymentInstructions) and overlay them onto the
  // view. This is what lets the client's remount-restore path
  // (use-loop-order-restore.ts) rebuild the pay screen ENTIRELY from this
  // response instead of from client-persisted storage — so no
  // payment-directing field (address, memo, amount, asset, paymentUri) is
  // ever trusted from sessionStorage/Keychain.
  //
  // Skipped for terminal orders (nothing to pay) and credit orders (no
  // on-chain payment). A derivation failure (oracle down / issuer unset)
  // leaves the fields null — the order view still returns fine; the client
  // just can't resume the pay screen until config/oracle recovers.
  if (!isTerminalOrderState(row.state) && row.paymentMethod !== 'credit') {
    const derived = await deriveLoopPaymentInstructions(row);
    if (derived.ok && derived.payment.method !== 'credit') {
      view.assetAmount = derived.payment.assetAmount;
      view.paymentUri = derived.payment.paymentUri;
      if (derived.payment.method === 'loop_asset') {
        view.assetCode = derived.payment.assetCode;
        view.assetIssuer = derived.payment.assetIssuer;
      }
    }
  }

  return c.json(view);
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
        ? // A2-1610: typed `lt()` — postgres-js can't bind a Date
          // through the raw sql interpolator. See `audit-tail-csv.ts`.
          and(eq(orders.userId, auth.userId), lt(orders.createdAt, beforeDate))
        : eq(orders.userId, auth.userId),
    )
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  return c.json({ orders: rows.map(orderToView) });
}
