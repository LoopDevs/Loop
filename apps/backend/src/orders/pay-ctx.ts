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
 *   1. Idempotency (hardening A4 — two layers). The procurement
 *      worker can be re-run for the same order (stuck-procurement
 *      sweep, mid-flight crash).
 *        a. Durable settlement record: one `ctx_settlements` row per
 *           order pins the intent and persists the deterministic tx
 *           hash BEFORE the network submit (CF-18 pattern). A re-run
 *           asks Horizon for that exact hash — a point lookup with no
 *           history window, immune to deposit traffic on the shared
 *           deposit+operator account. This is also the only durable
 *           evidence outside the chain that Loop paid CTX.
 *        b. Memo-scan fallback (`findOutboundPaymentByMemo`) for
 *           pre-A4 orders and the crash-between-sign-and-persist
 *           sliver; hits are backfilled into the settlement record.
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
import { getOutboundPaymentByTxHash } from '../payments/horizon.js';
import { submitNativePayment, PayoutSubmitError } from '../payments/payout-submit.js';
import { resolvePayoutConfig } from '../payments/payout-worker.js';
import {
  backfillCtxSettlementFromChain,
  getCtxSettlementByOrderId,
  getOrCreateCtxSettlement,
  markCtxSettlementConfirmed,
  recordCtxSettlementTxHash,
} from './ctx-settlements.js';

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
  /** Loop order id — keys the durable settlement record (hardening A4). */
  orderId: string;
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

  const amountStroops = decimalToStroops(args.amount);
  if (amountStroops === null || amountStroops <= 0n) {
    // Fail-closed: an unparseable SEP-7 amount must never reach the
    // signer or the settlement record.
    throw new PayCtxReconcileError(`unparseable CTX payment amount '${args.amount}'`);
  }

  // Hardening A4, layer 1: durable settlement record + AUTHORITATIVE
  // hash lookup. If a prior attempt persisted its tx hash (persisted
  // BEFORE the network submit, CF-18 pattern), ask Horizon directly
  // whether that exact tx landed — a point lookup has no history
  // window, so a re-run converges correctly no matter how many
  // deposits have interleaved on the shared deposit+operator account.
  // This closes the double-pay path the memo scan's bounded window
  // left open.
  const settlement = await getCtxSettlementByOrderId(args.orderId);
  if (settlement !== null) {
    // The pinned intent must match this attempt's URI — CTX's
    // Idempotency-Key contract returns the same payment URI per
    // order, so drift means a tampered/rotated URI. Fail closed.
    if (
      settlement.destination !== args.destination ||
      settlement.memoText !== args.memo ||
      settlement.amountStroops !== amountStroops
    ) {
      log.error(
        {
          orderId: args.orderId,
          pinned: {
            destination: settlement.destination,
            memo: settlement.memoText,
            amountStroops: settlement.amountStroops.toString(),
          },
          got: { destination: args.destination, memo: args.memo, amount: args.amount },
        },
        'CTX settlement record mismatches this attempt — refusing to pay',
      );
      throw new PayCtxReconcileError(
        `settlement record for order ${args.orderId} mismatches this attempt's payment URI`,
      );
    }
    if (settlement.txHash !== null) {
      const landed = await getOutboundPaymentByTxHash(settlement.txHash);
      if (landed?.landed === true) {
        if (settlement.confirmedAt === null) {
          await markCtxSettlementConfirmed(settlement.id);
        }
        log.info(
          { orderId: args.orderId, memo: args.memo, txHash: settlement.txHash },
          'CTX payment already on chain (authoritative hash) — skipping submit',
        );
        return { txHash: settlement.txHash, submitted: false };
      }
      // landed=false (tx on chain but failed) or null (never landed):
      // fall through to a fresh submit with a new sequence; onSigned
      // overwrites the stale hash.
    }
  }

  // Layer 2 fallback — the memo scan. Covers orders settled before
  // the durable record existed and the crash-between-sign-and-persist
  // sliver. The lookup walks Horizon's outbound
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
      'CTX payment already on chain (memo scan) — skipping submit',
    );
    // Backfill the durable record so the NEXT re-run converges via
    // the authoritative hash without a scan.
    await backfillCtxSettlementFromChain({
      orderId: args.orderId,
      destination: args.destination,
      memoText: args.memo,
      amountStroops,
      txHash: prior.txHash,
    });
    return { txHash: prior.txHash, submitted: false };
  }

  // Fresh submit. Create (or reuse) the settlement intent row, then
  // persist the deterministic tx hash via onSigned BEFORE the network
  // submit — a persist failure aborts the submit (better to retry
  // than to send a tx we cannot later prove we sent).
  const intentRow =
    settlement ??
    (await getOrCreateCtxSettlement({
      orderId: args.orderId,
      destination: args.destination,
      memoText: args.memo,
      amountStroops,
    }));

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
      onSigned: async (signedHash) => {
        await recordCtxSettlementTxHash({ id: intentRow.id, txHash: signedHash });
      },
    });
    await markCtxSettlementConfirmed(intentRow.id);
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
