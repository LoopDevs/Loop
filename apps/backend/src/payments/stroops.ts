/**
 * Horizon-string → BigInt stroops parser.
 *
 * Lifted out of `./watcher.ts` and `./horizon-balances.ts`, both
 * of which previously held byte-identical private copies of this
 * function. Centralising prevents drift the next time someone
 * tweaks the parsing rules in only one of the two call sites.
 *
 * Stellar always returns 7-decimal amounts as strings (e.g.
 * `"12.3456700"`). The rules are stable across native XLM, asset
 * trustlines (USDC, USDLOOP/GBPLOOP/EURLOOP), and payment
 * operations on `/payments_for_*` cursors — so this single
 * implementation covers every Horizon-amount surface the backend
 * touches.
 *
 * Throws on malformed input. Both original call sites treated an
 * unparseable amount as a critical data-integrity issue (the tx
 * went through but the value can't be reasoned about); preserving
 * that contract here keeps callers' try/catch flows correct.
 */

/**
 * Converts a Horizon amount string (`"12.3456700"`, `"42"`,
 * `"0.0000001"`, etc.) to BigInt stroops at Stellar's fixed 7
 * decimal places. Throws on malformed input.
 */
export function parseStroops(amount: string): bigint {
  const dot = amount.indexOf('.');
  if (dot === -1) {
    return BigInt(amount) * 10_000_000n;
  }
  const integerPart = amount.slice(0, dot) || '0';
  const decimalPart = amount
    .slice(dot + 1)
    .padEnd(7, '0')
    .slice(0, 7);
  return BigInt(integerPart) * 10_000_000n + BigInt(decimalPart);
}
