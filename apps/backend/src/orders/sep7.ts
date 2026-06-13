/**
 * SEP-7 `web+stellar:pay?` URI parser.
 *
 * CTX's `POST /gift-cards` response carries a `paymentUrls.XLM` entry
 * shaped like:
 *
 *   web+stellar:pay?destination=G…&amount=0.12&memo=<order-id>
 *
 * Both the legacy proxy handler (`./handler.ts`) and the loop-native
 * procurement worker need to crack this URI open the same way: extract
 * the destination address, decimal amount, and text memo. Doing the
 * parse in one place means a schema shift from upstream (different
 * scheme, missing destination, etc.) trips the same fail-closed paths
 * everywhere instead of producing a half-decoded payment intent.
 *
 * Returns a discriminated union instead of throwing — callers want to
 * branch on the failure reason (UPSTREAM_ERROR 502 for the legacy
 * handler, `markOrderFailed` for the procurement worker).
 */

export interface ParsedSep7Pay {
  /** Stellar account to send to. */
  destination: string;
  /** Decimal amount string ready to hand to the SDK (`Operation.payment`). */
  amount: string;
  /** Text memo. CTX matches incoming payments to orders by this value. */
  memo: string;
}

export type Sep7ParseError =
  | 'wrong-scheme'
  | 'missing-destination'
  | 'missing-amount'
  | 'missing-memo'
  | 'unsupported-memo-type';

export type Sep7ParseResult =
  | { ok: true; value: ParsedSep7Pay }
  | { ok: false; error: Sep7ParseError };

const STELLAR_PAY_PREFIX = 'web+stellar:pay?';

/**
 * Parses a CTX-issued SEP-7 payment URI into the three fields the
 * caller needs to submit a Stellar payment.
 *
 * - `wrong-scheme`: URI doesn't start with `web+stellar:pay?`. A future
 *   CTX-side change to e.g. `stellar:pay?` or `bitcoin:` would trip
 *   this rather than silently coercing into an empty parse.
 * - `missing-destination`: no `destination` query param. Without this
 *   we'd send to an empty string and the SDK would throw, but failing
 *   here surfaces the right error code to the caller.
 * - `missing-amount`: no `amount` query param. CTX always includes
 *   this for crypto purchases; missing it means a schema drift.
 * - `missing-memo`: no `memo` query param. CTX uses a shared custodial
 *   wallet + per-order memo to match incoming payments — a memoless
 *   payment is unrecoverable, so fail-closed.
 * - `unsupported-memo-type`: the URI declares a `memo_type` other than
 *   `MEMO_TEXT`. The payment submitter (`submitNativePayment`) only
 *   builds `Memo.text`, and the idempotency lookup
 *   (`findOutboundPaymentByMemo`) only matches `memo_type='text'`, so a
 *   `MEMO_ID` / `MEMO_HASH` / `MEMO_RETURN` URI would otherwise be sent
 *   as the wrong memo type — CTX could never reconcile it and the order
 *   would strand `unpaid` after we'd already spent the XLM. Fail-closed
 *   so the order is marked `failed` (and surfaced) instead of silently
 *   mis-paid. CTX has only ever issued `MEMO_TEXT` in practice; this is
 *   a guard against a future upstream change, not current behaviour.
 */
const SUPPORTED_MEMO_TYPES = new Set(['', 'text', 'MEMO_TEXT']);

export function parseSep7PayUri(uri: string): Sep7ParseResult {
  if (!uri.startsWith(STELLAR_PAY_PREFIX)) {
    return { ok: false, error: 'wrong-scheme' };
  }
  const params = new URLSearchParams(uri.slice(STELLAR_PAY_PREFIX.length));
  // `URLSearchParams.get()` already decodes percent-encoding. Don't
  // double-decode the memo / address — it would throw on malformed
  // sequences (`%ZZ`) and silently corrupt valid ones.
  const destination = params.get('destination') ?? '';
  const amount = params.get('amount') ?? '';
  const memo = params.get('memo') ?? '';
  // SEP-7 omits `memo_type` for text memos; treat absent as text.
  const memoType = params.get('memo_type') ?? '';
  if (destination === '') return { ok: false, error: 'missing-destination' };
  if (amount === '') return { ok: false, error: 'missing-amount' };
  if (memo === '') return { ok: false, error: 'missing-memo' };
  if (!SUPPORTED_MEMO_TYPES.has(memoType)) {
    return { ok: false, error: 'unsupported-memo-type' };
  }
  return { ok: true, value: { destination, amount, memo } };
}
