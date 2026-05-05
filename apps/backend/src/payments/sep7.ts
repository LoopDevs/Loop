/**
 * SEP-7 `web+stellar:pay?...` URI builder + asset-amount helpers.
 *
 * Used by the Loop-native order create response so clients can both:
 *   - Show a "send X.XXXXXXX <asset>" line (computed from `chargeMinor`
 *     via the live oracle / FX feed at order creation time)
 *   - Render a single "Open in wallet" button that deep-links into any
 *     installed Stellar wallet via the SEP-7 URI scheme
 *
 * The asset amount is computed at creation time and is a *quote*; the
 * watcher's `isAmountSufficient` re-validates at receipt against the
 * current oracle. In-flight rate movement during a normal user payment
 * window (~1–5 min) is absorbed by the watcher's `>=` comparison —
 * users sending the quoted amount when the rate is slightly favourable
 * pay slightly more than required, which is fine. Movement against the
 * user can cause a watcher rejection; today this is acceptable for
 * Phase 1 demo scope. Future: pin the rate on the order row + watcher
 * honours within a short expiry window.
 */
import { requiredStroopsForCharge, usdcStroopsPerCent } from './price-feed.js';

/**
 * Converts a stroops bigint to a 7-decimal human-readable string.
 * Stellar amounts are always 7 decimals; SEP-7 expects this format.
 *
 * Example: `12_345_670n` → `"1.2345670"`.
 */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = abs % 10_000_000n;
  const fracStr = frac.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/**
 * Computes the USDC asset amount for an order's `chargeMinor` using
 * the live USDC FX feed. Returns the amount as a human-readable
 * 7-decimal string (e.g. `"24.0000000"`) and the underlying stroops.
 */
export async function usdcAmountFor(
  chargeMinor: bigint,
  chargeCurrency: 'USD' | 'GBP' | 'EUR',
): Promise<{ stroops: bigint; formatted: string }> {
  const perCent = await usdcStroopsPerCent(chargeCurrency);
  const stroops = chargeMinor * perCent;
  return { stroops, formatted: formatStroops(stroops) };
}

/**
 * Computes the XLM asset amount for an order's `chargeMinor` using
 * the live XLM price oracle. Returns the amount as a human-readable
 * 7-decimal string.
 */
export async function xlmAmountFor(
  chargeMinor: bigint,
  chargeCurrency: 'USD' | 'GBP' | 'EUR',
): Promise<{ stroops: bigint; formatted: string }> {
  const stroops = await requiredStroopsForCharge(chargeMinor, chargeCurrency);
  return { stroops, formatted: formatStroops(stroops) };
}

/**
 * For LOOP-asset payments (USDLOOP/GBPLOOP/EURLOOP), the asset is 1:1
 * with matching fiat at 7 decimals. Conversion is purely arithmetic —
 * no oracle round-trip needed. `chargeMinor` (cents) × 100_000 stroops
 * per cent = LOOP-asset stroops.
 */
export function loopAssetAmountFor(chargeMinor: bigint): { stroops: bigint; formatted: string } {
  const stroops = chargeMinor * 100_000n;
  return { stroops, formatted: formatStroops(stroops) };
}

/**
 * Builds a SEP-7 `web+stellar:pay?...` URI for the given payment
 * parameters. Stellar wallets (Lobstr, Freighter, xBull, Hana, etc)
 * register as handlers for the `web+stellar:` scheme on iOS/Android;
 * desktop browsers route to whichever wallet extension has registered
 * the scheme. Tapping/clicking the URI opens the wallet pre-populated
 * with destination / amount / memo / asset.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */
export function buildSep7PayUri(args: {
  destination: string;
  /** 7-decimal human-readable amount string. Use `formatStroops`. */
  amount: string;
  memo: string;
  /** Always MEMO_TEXT for Loop's deposit memos (alphanumeric). */
  memoType?: 'MEMO_TEXT' | 'MEMO_HASH' | 'MEMO_ID';
  /** Omit for native XLM. Set for USDC and LOOP-assets. */
  assetCode?: string;
  /** Required when `assetCode` is set; ignored otherwise. */
  assetIssuer?: string;
  /** Optional client message — appears in the wallet confirmation UI. */
  msg?: string;
}): string {
  const params = new URLSearchParams();
  params.set('destination', args.destination);
  params.set('amount', args.amount);
  params.set('memo', args.memo);
  params.set('memo_type', args.memoType ?? 'MEMO_TEXT');
  if (args.assetCode !== undefined && args.assetCode !== 'XLM') {
    params.set('asset_code', args.assetCode);
    if (args.assetIssuer !== undefined) {
      params.set('asset_issuer', args.assetIssuer);
    }
  }
  if (args.msg !== undefined && args.msg.length > 0) {
    params.set('msg', args.msg);
  }
  return `web+stellar:pay?${params.toString()}`;
}
