/**
 * `payCtxOrder` — forwards user-paid XLM to CTX (ADR 010).
 *
 * Under the principal-switch design, Loop is merchant of record:
 * the user pays Loop's deposit address, then Loop pays CTX's
 * per-order destination from the operator wallet. This file owns
 * that hop.
 *
 * Three responsibilities:
 *
 *   1. Idempotency. The procurement worker can be re-run for the
 *      same order (stuck-procurement sweep, mid-flight crash). The
 *      `POST /gift-cards` request carries `Idempotency-Key:
 *      <order.id>` so CTX returns the same gift-card + payment URI
 *      on retry. We use that URI's memo to ask Horizon "have we
 *      already sent this memo from the operator account to this
 *      destination?" — if yes, return the existing tx hash without
 *      re-submitting. Same primitive the LOOP-asset payout worker
 *      uses for its retries (`findOutboundPaymentByMemo`).
 *
 *   2. Submit. If no prior payment matches, build + sign + submit
 *      a NATIVE XLM payment with the SEP-7 URI's amount + memo.
 *
 *   3. Classify. Network/transient failures throw — caller decides
 *      whether to retry or fail the order. `LOOP_STELLAR_OPERATOR_SECRET`
 *      missing is `PaymentCtxConfigError` — operator config bug,
 *      not transient.
 */
import { logger } from '../logger.js';
import { findOutboundPaymentByMemo } from '../payments/horizon-find-outbound.js';
import { submitNativePayment, PayoutSubmitError } from '../payments/payout-submit.js';
import { resolvePayoutConfig } from '../payments/payout-worker.js';

const log = logger.child({ area: 'pay-ctx' });

export class PayCtxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayCtxConfigError';
  }
}

/**
 * Thrown when the idempotency lookup finds a prior outbound payment
 * with this order's memo but a DIFFERENT amount or asset than this
 * order requires. That means the memo isn't actually a prior submit
 * of *this* order (CTX memo collision, or a tampered/duplicated URI):
 * skipping would leave CTX unpaid for this order, and blindly
 * re-submitting against a colliding memo could double-pay. Fail-closed
 * so `procureOne` marks the order `failed` and an operator
 * investigates instead. Distinct from the (expected) idempotent
 * same-amount re-run, which still skips silently.
 */
export class PayCtxReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayCtxReconcileError';
  }
}

export interface PayCtxArgs {
  /** CTX destination address from the SEP-7 URI. */
  destination: string;
  /** Decimal-string amount from the SEP-7 URI (e.g. `"0.1198323"`). */
  amount: string;
  /** Per-order memo from the SEP-7 URI. CTX matches inbound payments to orders by this. */
  memo: string;
}

export interface PayCtxResult {
  txHash: string;
  /**
   * True when this call actually submitted a tx to Horizon. False
   * when the idempotency lookup found a prior submit. Callers can
   * log differently for visibility but the outcome — CTX is paid —
   * is the same either way.
   */
  submitted: boolean;
}

/**
 * Pays CTX from the operator wallet. Idempotent: re-running for the
 * same memo skips the submit if Horizon already shows a matching
 * outbound payment.
 *
 * Throws:
 *   - `PayCtxConfigError` — operator secret unset / invalid.
 *   - `PayoutSubmitError` — submit failed (transient or terminal;
 *     the `.kind` field tells the caller which).
 *   - Any other thrown error from the idempotency lookup or SDK.
 */
/**
 * Decimal-string → stroops (1 XLM = 10^7 stroops) as bigint, so two
 * amount strings that differ only in trailing-zero / format
 * (`"0.12"` vs `"0.1200000"`) compare equal and we don't false-alarm
 * the reconcile guard. Returns null on a non-decimal string so callers
 * treat an unparseable amount as a mismatch (fail-closed).
 */
export function decimalToStroops(s: string): bigint | null {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (frac.length > 7) return null; // more precision than stroops can hold
  const fracPadded = frac.padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

function amountsEqual(a: string, b: string): boolean {
  const sa = decimalToStroops(a);
  const sb = decimalToStroops(b);
  if (sa === null || sb === null) return false;
  return sa === sb;
}

export async function payCtxOrder(args: PayCtxArgs): Promise<PayCtxResult> {
  const cfg = resolvePayoutConfig();
  if (cfg === null) {
    throw new PayCtxConfigError('LOOP_STELLAR_OPERATOR_SECRET unset or invalid — cannot pay CTX');
  }

  // Idempotency check first. The lookup walks Horizon's outbound
  // payments from the operator account; a prior submit lands on
  // page 1 within seconds, so the typical cost is one Horizon hit.
  //
  // CF-18: this path benefits from the deeper default page window (the
  // scan was widened from ~600 to ~1600 records, which matters here
  // because operator==deposit interleaves inbound deposits into the same
  // feed). We deliberately do NOT pass `expectedAmountStroops` /
  // `expectedAssetCode` to the scan: pay-ctx's idempotency must FAIL
  // CLOSED on a memo collision (a same-memo prior payment with a
  // different amount/asset means the URI was reused or tampered, and
  // submitting a second tx could double-pay) — so we want the first
  // memo+from+to hit returned here and reconciled below, not silently
  // skipped. The amount+asset assertion lives in the reconcile block.
  const prior = await findOutboundPaymentByMemo({
    account: cfg.operatorAccount,
    to: args.destination,
    memo: args.memo,
  });
  if (prior !== null) {
    // A memo + destination match alone is NOT proof we already paid
    // THIS order — the amount and asset must match too. CTX issues a
    // shared custodial destination + per-order memo, so the only
    // legitimate prior match is an earlier submit of the same order,
    // which carries the same SEP-7 amount and is native XLM. A
    // mismatch means a memo collision (or a tampered URI): treating it
    // as "already paid" is exactly the silent-strand failure mode, so
    // fail-closed instead.
    const amountMatches = amountsEqual(prior.amount, args.amount);
    const isNative = prior.assetCode === null;
    if (!amountMatches || !isNative) {
      log.error(
        {
          memo: args.memo,
          destination: args.destination,
          wantAmount: args.amount,
          priorAmount: prior.amount,
          priorAssetCode: prior.assetCode,
          priorTxHash: prior.txHash,
        },
        'CTX idempotency match has mismatched amount/asset — refusing to treat as paid',
      );
      throw new PayCtxReconcileError(
        `prior payment for memo ${args.memo} mismatches order (amount ${prior.amount} vs ${args.amount}, asset ${prior.assetCode ?? 'native'})`,
      );
    }
    log.info(
      { memo: args.memo, destination: args.destination, txHash: prior.txHash },
      'CTX payment already on chain — skipping submit',
    );
    return { txHash: prior.txHash, submitted: false };
  }

  try {
    const res = await submitNativePayment({
      secret: cfg.operatorSecret,
      horizonUrl: cfg.horizonUrl,
      networkPassphrase: cfg.networkPassphrase,
      intent: {
        to: args.destination,
        amount: args.amount,
        memoText: args.memo,
      },
    });
    log.info(
      { memo: args.memo, destination: args.destination, amount: args.amount, txHash: res.txHash },
      'CTX payment submitted',
    );
    return { txHash: res.txHash, submitted: true };
  } catch (err) {
    if (err instanceof PayoutSubmitError) {
      log.error(
        {
          memo: args.memo,
          destination: args.destination,
          amount: args.amount,
          kind: err.kind,
          resultCodes: err.resultCodes,
        },
        'CTX payment submit failed',
      );
    }
    throw err;
  }
}
