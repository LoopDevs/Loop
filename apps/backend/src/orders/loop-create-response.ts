/**
 * Loop-native create-order response builder (ADR 010 / 015).
 *
 * Lifted out of `./loop-handler.ts`. After `createOrder` returns
 * the persisted row, the handler branches three ways on payment
 * method to shape the wire response:
 *
 *   - `credit`     → no payment instructions, just the orderId +
 *     home-currency charge
 *   - `loop_asset` → Stellar deposit address + memo + LOOP-asset
 *     {code, issuer} pair, with a flywheel-signal Discord fanout
 *     (`notifyCashbackRecycled` + first-time milestone)
 *   - `xlm` / `usdc` → Stellar deposit address + memo
 *
 * The `loop_asset` branch additionally fails closed (503) when the
 * region's issuer env var isn't set — the order row is already
 * written so the 24h expiry sweep cleans up; client retries later.
 *
 * Co-locating the branching here keeps the handler's body focused
 * on validation + create; the response shaping (and the Discord
 * fanout that travels with `loop_asset`) lives in one place.
 */
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { type CreateLoopOrderResponse, type Merchant } from '@loop/shared';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { notifyCashbackRecycled, notifyFirstCashbackRecycled } from '../discord.js';
import { type Order } from './repo.js';

const log = logger.child({ handler: 'loop-orders' });

/**
 * Builds the `POST /api/orders/loop` response from a freshly-
 * created order row. `firstLoopAsset` is true when this is the
 * caller's first-ever `loop_asset` order — gates the milestone
 * Discord notification.
 */
export function buildLoopCreateResponse(
  c: Context,
  args: {
    order: Order;
    userId: string;
    homeCurrency: 'USD' | 'GBP' | 'EUR';
    merchant: Merchant;
    firstLoopAsset: boolean;
  },
): Response {
  const { order, userId, homeCurrency, merchant, firstLoopAsset } = args;
  const base = {
    orderId: order.id,
  };
  if (order.paymentMethod === 'credit') {
    return c.json<CreateLoopOrderResponse>({
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
    const payoutAsset = payoutAssetFor(homeCurrency);
    if (payoutAsset.issuer === null) {
      // The issuer env isn't set for this currency. We already
      // wrote the order row; roll back isn't worth the complexity
      // here since the row will hit the 24h expiry sweep. Log and
      // 503 so the client can retry later.
      log.error(
        { homeCurrency, assetCode: payoutAsset.code },
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
        userId,
        merchantName: merchant.name,
        amount: Number(order.faceValueMinor) / 100,
        currency: order.currency,
        assetCode: payoutAsset.code,
      });
    }
    return c.json<CreateLoopOrderResponse>({
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
  return c.json<CreateLoopOrderResponse>({
    ...base,
    payment: {
      method: order.paymentMethod as 'xlm' | 'usdc',
      stellarAddress: env.LOOP_STELLAR_DEPOSIT_ADDRESS!,
      memo: order.paymentMemo ?? '',
      amountMinor: order.chargeMinor.toString(),
      currency: order.chargeCurrency,
    },
  });
}
