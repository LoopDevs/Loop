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
export async function payCtxOrder(args: PayCtxArgs): Promise<PayCtxResult> {
  const cfg = resolvePayoutConfig();
  if (cfg === null) {
    throw new PayCtxConfigError('LOOP_STELLAR_OPERATOR_SECRET unset or invalid — cannot pay CTX');
  }

  // Idempotency check first. The lookup walks Horizon's outbound
  // payments from the operator account; a prior submit lands on
  // page 1 within seconds, so the typical cost is one Horizon hit.
  const prior = await findOutboundPaymentByMemo({
    account: cfg.operatorAccount,
    to: args.destination,
    memo: args.memo,
  });
  if (prior !== null) {
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
