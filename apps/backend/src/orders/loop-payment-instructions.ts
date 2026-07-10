/**
 * Pure derivation of a Loop-native order's on-chain payment instructions
 * (ADR 010 / 015) from a persisted order row.
 *
 * Extracted from `loop-replay-response.ts` (A2-2003) so the SAME
 * server-authoritative derivation — live oracle / FX re-quote + SEP-7
 * build from `chargeMinor`/`chargeCurrency`/`paymentMethod` + env issuers
 * — feeds THREE callers with one implementation:
 *
 *   1. `replayOrderResponse` — the idempotent `POST /api/orders/loop`
 *      retry path (thin wrapper over this).
 *   2. `loopGetOrderHandler` — `GET /api/orders/loop/:id` populates the
 *      read view's payment-guidance fields (Q6-4b hardening) so the
 *      remount-restore path can rebuild the pay screen ENTIRELY from the
 *      server, never from client-persisted storage.
 *
 * (`buildLoopCreateResponse`, the first-create path, keeps its own copy
 * because it interleaves Discord flywheel notifications + the
 * `firstLoopAsset` milestone with the response build; the payment math it
 * runs is identical to this function's.)
 *
 * Returns a discriminated result rather than a Hono `Response` so
 * non-HTTP callers (the read handler, which must still return the order
 * view even when instructions can't be derived) can branch without a
 * fake `Context`.
 */
import { logger } from '../logger.js';
import { env } from '../env.js';
import { isHomeCurrency, type CreateLoopOrderResponse } from '@loop/shared';
import { payoutAssetFor } from '../credits/payout-asset.js';
import {
  buildSep7PayUri,
  loopAssetAmountFor,
  usdcAmountFor,
  xlmAmountFor,
} from '../payments/sep7.js';

const log = logger.child({ area: 'loop-payment-instructions' });

/** The order fields this derivation needs — a structural subset of `Order`. */
export interface OrderForPaymentDerivation {
  id: string;
  paymentMethod: string;
  chargeMinor: bigint;
  chargeCurrency: string;
  paymentMemo: string | null;
}

/**
 * `ok` carries the `CreateLoopOrderResponse['payment']` payload (the exact
 * shape the create/replay endpoints emit). `!ok` carries the HTTP mapping
 * the replay path uses (503 for unconfigured / oracle-down-is-still-ok
 * cases, 500 for stored-currency drift) so `replayOrderResponse` stays
 * byte-for-byte compatible; the read handler ignores the status and just
 * leaves the view's payment fields null.
 */
export type DerivedLoopPayment =
  | { ok: true; payment: CreateLoopOrderResponse['payment'] }
  | { ok: false; status: 500 | 503; code: string; message: string };

export async function deriveLoopPaymentInstructions(
  order: OrderForPaymentDerivation,
): Promise<DerivedLoopPayment> {
  if (order.paymentMethod === 'credit') {
    return {
      ok: true,
      payment: {
        method: 'credit',
        amountMinor: order.chargeMinor.toString(),
        currency: order.chargeCurrency,
      },
    };
  }

  if (order.paymentMethod === 'loop_asset') {
    if (!isHomeCurrency(order.chargeCurrency)) {
      // Defence-in-depth: the DB CHECK constraint pins charge_currency to
      // the supported set; a stored row that no longer parses means schema
      // drift. Refuse rather than guess.
      log.error(
        { orderId: order.id, chargeCurrency: order.chargeCurrency },
        'loop_asset order has charge_currency outside the home-currency enum',
      );
      return {
        ok: false,
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Invalid stored order currency',
      };
    }
    const payoutAsset = payoutAssetFor(order.chargeCurrency);
    if (payoutAsset.issuer === null || env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
      return {
        ok: false,
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'LOOP asset not configured for your region',
      };
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
    return {
      ok: true,
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
    };
  }

  // xlm / usdc
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
    return {
      ok: false,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'On-chain payment temporarily unavailable',
    };
  }
  // Mirror loop-create-response.ts's guard: a usdc order with no configured
  // issuer would otherwise emit a SEP-7 URI with an empty `asset_issuer`
  // that no wallet can pay — un-payable, not un-safe (the deposit watcher
  // refuses to match any payment when the issuer is unconfigured).
  if (order.paymentMethod === 'usdc' && env.LOOP_STELLAR_USDC_ISSUER === undefined) {
    log.error({ orderId: order.id }, 'usdc order but LOOP_STELLAR_USDC_ISSUER not set');
    return {
      ok: false,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'USDC payment not configured',
    };
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
      'oracle unavailable — returning fiat-only fallback (zero asset amount)',
    );
    assetAmount = { stroops: 0n, formatted: '0.0000000' };
  }
  const paymentUri = buildSep7PayUri({
    destination: stellarAddress,
    amount: assetAmount.formatted,
    memo,
    ...(order.paymentMethod === 'usdc'
      ? // `?? ''` is defensive-only dead code: the guard above 503s before
        // this point whenever the issuer is unset.
        { assetCode: 'USDC', assetIssuer: env.LOOP_STELLAR_USDC_ISSUER ?? '' }
      : {}),
    msg: `Loop order ${order.id.slice(0, 8)}`,
  });
  return {
    ok: true,
    payment: {
      method: order.paymentMethod as 'xlm' | 'usdc',
      stellarAddress,
      memo,
      amountMinor: order.chargeMinor.toString(),
      currency: order.chargeCurrency,
      assetAmount: assetAmount.formatted,
      paymentUri,
    },
  };
}
