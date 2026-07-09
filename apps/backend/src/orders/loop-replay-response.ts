/**
 * A2-2003 idempotent-replay shaper for `POST /api/orders/loop`.
 *
 * Lifted out of `apps/backend/src/orders/loop-handler.ts`. Pure
 * response-builder: takes a stored `Order` row + the request
 * context and re-emits the original `OrderPaymentResponse` shape
 * the client got when the order was first created.
 *
 * Two callers in the parent handler:
 *
 *   1. Lookup-first short-circuit — a repeat POST with the same
 *      `(user_id, idempotency_key)` pair short-circuits before we
 *      hit `createOrder` at all.
 *   2. `IdempotentOrderConflictError` recovery — when a concurrent
 *      caller raced us through the lookup, the unique-index
 *      violation in the insert path lands the existing row in our
 *      hands and we replay through this function.
 *
 * Discord notifications (`notifyCashbackRecycled` /
 * `notifyFirstCashbackRecycled`) are deliberately NOT re-fired
 * here — those are tied to user intent at first creation; firing
 * them again on every retry would dilute the signal and risk
 * per-attempt double-pings on a flaky client.
 *
 * Stays close to `loop-handler.ts` (sibling file) rather than a
 * shared helper module: the only consumer is `loopCreateOrderHandler`
 * and the response shape is pinned to that endpoint.
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { isHomeCurrency } from '@loop/shared';
import { payoutAssetFor } from '../credits/payout-asset.js';
import {
  buildSep7PayUri,
  loopAssetAmountFor,
  usdcAmountFor,
  xlmAmountFor,
} from '../payments/sep7.js';
import { type Order } from './repo.js';
import type { OrderPaymentResponse } from './loop-handler.js';

const log = logger.child({ handler: 'loop-orders' });

/**
 * A2-2003: build the create-order response from an already-persisted
 * row. Two callers:
 *   - lookup-first short-circuit before we even hit `createOrder`
 *     (a repeat post within TTL),
 *   - `IdempotentOrderConflictError` recovery when a concurrent
 *     caller raced us through that lookup.
 *
 * Discord notifications (`notifyCashbackRecycled` / `notifyFirstCashbackRecycled`)
 * are deliberately NOT re-fired here — those are tied to user intent
 * at first creation; firing them again on every retry would dilute
 * the signal and risk per-attempt double-pings on a flaky client.
 */
export async function replayOrderResponse(c: Context, order: Order): Promise<Response> {
  const base = { orderId: order.id };
  if (order.paymentMethod === 'credit') {
    return c.json<OrderPaymentResponse>({
      ...base,
      payment: {
        method: 'credit',
        amountMinor: order.chargeMinor.toString(),
        currency: order.chargeCurrency,
      },
    });
  }
  if (order.paymentMethod === 'loop_asset') {
    if (!isHomeCurrency(order.chargeCurrency)) {
      // Defence-in-depth: the DB CHECK constraint pins charge_currency
      // to the supported set; a stored row that no longer parses means
      // schema drift. Refuse to replay rather than guess.
      log.error(
        { orderId: order.id, chargeCurrency: order.chargeCurrency },
        'replay: stored loop_asset order has charge_currency outside the home-currency enum',
      );
      return c.json({ code: 'INTERNAL_ERROR', message: 'Invalid stored order currency' }, 500);
    }
    const payoutAsset = payoutAssetFor(order.chargeCurrency);
    if (payoutAsset.issuer === null || env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'LOOP asset not configured for your region' },
        503,
      );
    }
    const memo = order.paymentMemo ?? '';
    const stellarAddress = env.LOOP_STELLAR_DEPOSIT_ADDRESS;
    const loopAssetAmount = loopAssetAmountFor(order.chargeMinor);
    const paymentUri = buildSep7PayUri({
      destination: stellarAddress,
      amount: loopAssetAmount.formatted,
      memo,
      assetCode: payoutAsset.code,
      assetIssuer: payoutAsset.issuer,
      msg: `Loop order ${order.id.slice(0, 8)}`,
    });
    return c.json<OrderPaymentResponse>({
      ...base,
      payment: {
        method: 'loop_asset',
        stellarAddress,
        memo,
        amountMinor: order.chargeMinor.toString(),
        currency: order.chargeCurrency,
        assetCode: payoutAsset.code,
        assetIssuer: payoutAsset.issuer,
        assetAmount: loopAssetAmount.formatted,
        paymentUri,
      },
    });
  }
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
    return c.json(
      { code: 'SERVICE_UNAVAILABLE', message: 'On-chain payment temporarily unavailable' },
      503,
    );
  }
  // Mirror loop-create-response.ts's same-shaped guard (AUDIT-2 P2
  // follow-up 'b'): a replayed usdc order with no configured issuer
  // would otherwise re-emit a SEP-7 URI with an empty `asset_issuer`
  // that no wallet can pay — un-payable, not un-safe (the deposit
  // watcher already refuses to match any payment when the issuer is
  // unconfigured, AUDIT-2 finding A).
  if (order.paymentMethod === 'usdc' && env.LOOP_STELLAR_USDC_ISSUER === undefined) {
    log.error({ orderId: order.id }, 'replay: usdc order but LOOP_STELLAR_USDC_ISSUER not set');
    return c.json({ code: 'SERVICE_UNAVAILABLE', message: 'USDC payment not configured' }, 503);
  }
  const memo = order.paymentMemo ?? '';
  const stellarAddress = env.LOOP_STELLAR_DEPOSIT_ADDRESS;
  const chargeCurrency = order.chargeCurrency as 'USD' | 'GBP' | 'EUR';
  let assetAmount: { stroops: bigint; formatted: string };
  try {
    if (order.paymentMethod === 'usdc') {
      assetAmount = await usdcAmountFor(order.chargeMinor, chargeCurrency);
    } else {
      assetAmount = await xlmAmountFor(order.chargeMinor, chargeCurrency);
    }
  } catch (err) {
    log.error(
      { err, orderId: order.id, paymentMethod: order.paymentMethod },
      'Replay: oracle unavailable — returning fiat-only fallback',
    );
    assetAmount = { stroops: 0n, formatted: '0.0000000' };
  }
  const paymentUri = buildSep7PayUri({
    destination: stellarAddress,
    amount: assetAmount.formatted,
    memo,
    ...(order.paymentMethod === 'usdc'
      ? // `?? ''` is defensive-only dead code: the guard above already
        // 503s before this point whenever the issuer is unset.
        { assetCode: 'USDC', assetIssuer: env.LOOP_STELLAR_USDC_ISSUER ?? '' }
      : {}),
    msg: `Loop order ${order.id.slice(0, 8)}`,
  });
  return c.json<OrderPaymentResponse>({
    ...base,
    payment: {
      method: order.paymentMethod as 'xlm' | 'usdc',
      stellarAddress,
      memo,
      amountMinor: order.chargeMinor.toString(),
      currency: order.chargeCurrency,
      assetAmount: assetAmount.formatted,
      paymentUri,
    },
  });
}
