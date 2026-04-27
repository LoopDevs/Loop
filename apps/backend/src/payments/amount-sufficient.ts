/**
 * `isAmountSufficient` — payment-amount validation gate (A2-619).
 *
 * Lifted out of `apps/backend/src/payments/watcher.ts`. Pure
 * function (modulo the per-call price-oracle fetch): given an
 * incoming Horizon payment + the order it\'s paying, decides
 * whether the payment covers what the user was charged in their
 * home currency (`chargeMinor` in `chargeCurrency`), NOT the
 * catalog-currency face value.
 *
 * Three rails — three different size-check policies:
 *   - LOOP asset (USDLOOP / GBPLOOP / EURLOOP) — 1:1 with matching
 *     fiat at 7 decimals, no oracle.
 *   - USDC — consults the USDC fiat-FX feed.
 *   - XLM — consults the XLM price oracle.
 *
 * Either oracle failure rejects — the watcher retries on the next
 * tick. The watcher\'s test suite (`./__tests__/watcher.test.ts`)
 * exercises every branch + every payment-method combination.
 *
 * Re-exported from `./watcher.ts` via the barrel pattern so the
 * test suite (which imports `isAmountSufficient` from `../watcher`)
 * keeps working without re-targeting.
 */
import type { HorizonPayment } from './horizon.js';
import type { Order } from '../orders/repo.js';
import type { LoopAssetCode } from '../credits/payout-asset.js';
import { logger } from '../logger.js';
import { stroopsPerCent, usdcStroopsPerCent } from './price-feed.js';
import { parseStroops } from './stroops.js';

const log = logger.child({ area: 'payment-watcher' });

/**
 * Returns true when `payment.amount` covers the amount the user was
 * charged in their home currency (`chargeMinor` in `chargeCurrency`),
 * NOT the catalog-currency face value (A2-619). The two coincide for
 * same-currency orders and diverge for cross-currency: a US user
 * buying a £100 Boots card at a $1.25/£ pin sends USDC for ~$125,
 * and the watcher must validate against $125, not £100.
 *
 * LOOP-asset payments (ADR 015) are 1:1 with matching fiat at 7
 * decimals — USDLOOP:USD = GBPLOOP:GBP = EURLOOP:EUR — so the size
 * check skips the oracle. USDC payments consult the USDC fiat-FX
 * feed; XLM payments consult the XLM price oracle. Either oracle
 * failure rejects — the watcher retries on the next tick.
 */
export async function isAmountSufficient(
  payment: HorizonPayment,
  order: Order,
  loopAssetCode: LoopAssetCode | null = null,
): Promise<boolean> {
  if (order.paymentMethod === 'credit') {
    // Credit-funded orders don't go through the watcher — they're
    // debited inline in the handler. Reaching this branch is a bug.
    return false;
  }
  if (payment.amount === undefined) return false;
  let receivedStroops: bigint;
  try {
    receivedStroops = parseStroops(payment.amount);
  } catch {
    log.error({ amount: payment.amount, orderId: order.id }, 'Unparseable payment amount');
    return false;
  }

  // LOOP-asset payment (ADR 015). The asset is 1:1 with its matching
  // fiat at 7 decimals — USDLOOP:USD = GBPLOOP:GBP = EURLOOP:EUR,
  // 100_000 stroops per minor unit — so the size check skips both
  // the XLM oracle and the USD FX feed. Reject when the asset's
  // currency doesn't match the order's charge currency: a user
  // paying GBPLOOP for a USD-charged order is either confused or
  // exploiting the 1:1 assumption cross-currency.
  if (loopAssetCode !== null) {
    const expectedCurrency = loopAssetCurrency(loopAssetCode);
    if (order.chargeCurrency !== expectedCurrency) {
      log.warn(
        {
          orderId: order.id,
          chargeCurrency: order.chargeCurrency,
          loopAssetCode,
        },
        'LOOP asset currency does not match order charge currency',
      );
      return false;
    }
    const requiredStroops = order.chargeMinor * 100_000n;
    return receivedStroops >= requiredStroops;
  }

  // A2-619: validate against what the user was *charged*
  // (`chargeMinor` in `chargeCurrency`), not the gift-card face value
  // in catalog currency. For same-currency orders these are equal and
  // behaviour is unchanged. For cross-currency orders (e.g. a US user
  // buying a £100 Boots card quoted as $125 at order time) the user's
  // wallet committed the charge-currency amount, so the oracle lookup
  // + requiredStroops must use the charge-currency basis or the check
  // silently rejects the exact expected payment.
  if (order.paymentMethod === 'usdc') {
    if (
      order.chargeCurrency !== 'USD' &&
      order.chargeCurrency !== 'GBP' &&
      order.chargeCurrency !== 'EUR'
    ) {
      log.warn(
        { orderId: order.id, chargeCurrency: order.chargeCurrency },
        'USDC path has no FX rate for charge currency',
      );
      return false;
    }
    try {
      const perCent = await usdcStroopsPerCent(order.chargeCurrency);
      const requiredStroops = order.chargeMinor * perCent;
      return receivedStroops >= requiredStroops;
    } catch (err) {
      log.warn({ err, orderId: order.id }, 'USDC FX oracle unavailable — rejecting USDC payment');
      return false;
    }
  }
  // xlm — query the oracle for the current rate in the order's
  // charge currency, convert the charged minor-unit total into
  // stroops, compare.
  if (
    order.chargeCurrency !== 'USD' &&
    order.chargeCurrency !== 'GBP' &&
    order.chargeCurrency !== 'EUR'
  ) {
    log.warn(
      { orderId: order.id, chargeCurrency: order.chargeCurrency },
      'XLM oracle has no rate for charge currency',
    );
    return false;
  }
  try {
    const perCent = await stroopsPerCent(order.chargeCurrency);
    const requiredStroops = order.chargeMinor * perCent;
    return receivedStroops >= requiredStroops;
  } catch (err) {
    log.warn({ err, orderId: order.id }, 'XLM price oracle unavailable — rejecting XLM payment');
    return false;
  }
}

/** Fiat currency backing each LOOP-branded stablecoin (1:1 by design). */
function loopAssetCurrency(code: LoopAssetCode): 'USD' | 'GBP' | 'EUR' {
  switch (code) {
    case 'USDLOOP':
      return 'USD';
    case 'GBPLOOP':
      return 'GBP';
    case 'EURLOOP':
      return 'EUR';
  }
}
