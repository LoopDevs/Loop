/**
 * Per-row state-machine for the payout worker (ADR 016).
 *
 * Lifted out of `apps/backend/src/payments/payout-worker.ts` so
 * the per-row submit pipeline (idempotency pre-check → claim →
 * submit → confirm; classify-and-fail on error) lives in a focused
 * ~170-line module separate from the interval-loop / config /
 * reset plumbing in the parent file.
 *
 * `payOne` and the `PayOutcome` type are imported back into
 * `payout-worker.ts` for the per-row dispatch in `runPayoutTick`.
 * `handleSubmitError` stays private to this file — it's only ever
 * called from `payOne`.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import {
  markPayoutSubmitted,
  markPayoutConfirmed,
  markPayoutFailed,
  reclaimSubmittedPayout,
  type PendingPayout,
} from '../credits/pending-payouts.js';
import { findOutboundPaymentByMemo } from './horizon.js';
import { getAccountTrustlines } from './horizon-trustlines.js';
import { submitPayout, PayoutSubmitError } from './payout-submit.js';
import { feeForAttempt } from './fee-strategy.js';
import { notifyPayoutFailed, notifyPayoutAwaitingTrustline } from '../discord.js';

const log = logger.child({ area: 'payout-worker' });

export type PayOutcome =
  | 'confirmed'
  | 'failed'
  | 'skippedAlreadyLanded'
  | 'skippedRace'
  | 'retriedLater';

/**
 * Subset of `RunPayoutTickArgs` that `payOne` actually depends on.
 * Defined locally so this module doesn't need to import the parent
 * file's interface (avoids a circular module dep).
 * `RunPayoutTickArgs` is structurally a superset, so the call site
 * passes its `args` straight through.
 */
export interface PayOneArgs {
  operatorSecret: string;
  /**
   * A4-104: operator account pubkey for the Horizon idempotency
   * pre-check. Must match the pubkey derived from `operatorSecret`
   * — `submitPayout` derives the same one for signing. Resolved
   * once in `resolvePayoutConfig` so this module doesn't pull in
   * the SDK on every tick.
   */
  operatorAccount: string;
  horizonUrl: string;
  networkPassphrase: string;
  maxAttempts: number;
}

export async function payOne(row: PendingPayout, args: PayOneArgs): Promise<PayOutcome> {
  // Pre-flight: does the destination account have a trustline to
  // this asset? Without it, `submitPayout` will get `op_no_trust`
  // back and the row will be marked `failed`, which is the wrong
  // outcome for the most common case (user linked a wallet but
  // forgot to add the LOOP-asset trustline). Instead: probe the
  // trustline first; if it's missing, leave the row in `pending`,
  // notify the user via Discord (throttled), and let the next
  // tick re-probe. The user can add the trustline at any moment
  // and the payout submits without admin intervention.
  //
  // Probe is cached at 30s TTL inside getAccountTrustlines, so
  // many pending payouts to the same address share one Horizon
  // round-trip per 30s. ADR-015 / ADR-016 §"trustline-probe before
  // payout submit" was the open Phase-1 question; this closes it.
  const trustlineSnapshot = await getAccountTrustlines(row.toAddress).catch((err: unknown) => {
    // Horizon read-degraded path: don't burn the row, retry next
    // tick. Same posture as the idempotency pre-check below — fail
    // closed.
    log.warn(
      { err, payoutId: row.id, account: row.toAddress },
      'Trustline pre-check Horizon read failed — leaving payout in pending for retry',
    );
    return null;
  });
  if (trustlineSnapshot === null) {
    return 'retriedLater';
  }
  const trustlineKey = `${row.assetCode}::${row.assetIssuer}`;
  const trustline = trustlineSnapshot.trustlines.get(trustlineKey);
  if (trustline === undefined) {
    log.warn(
      {
        payoutId: row.id,
        userId: row.userId,
        account: row.toAddress,
        assetCode: row.assetCode,
        accountExists: trustlineSnapshot.accountExists,
      },
      'Destination has no trustline — leaving payout in pending until user adds it',
    );
    notifyPayoutAwaitingTrustline({
      payoutId: row.id,
      userId: row.userId,
      account: row.toAddress,
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      accountExists: trustlineSnapshot.accountExists,
    });
    return 'retriedLater';
  }

  // Idempotency pre-check (ADR 016). If the prior submit landed
  // async between the last tick and this one, we observe the
  // payment in Horizon history and converge without issuing a
  // second tx. A4-104: scan the operator account (the signer) — the
  // earlier code reused `row.assetIssuer` here on the assumption
  // that operator == issuer for LOOP-branded assets. That collapses
  // for any treasury topology that splits issuer (cold) from
  // operator (hot), so the pre-check would scan the wrong history
  // and miss prior submits, opening a double-pay path.
  try {
    const prior = await findOutboundPaymentByMemo({
      account: args.operatorAccount,
      to: row.toAddress,
      memo: row.memoText,
    });
    if (prior !== null) {
      // markPayoutConfirmed is state-guarded on 'submitted'. A
      // row still in 'pending' must transition → 'submitted' first
      // so the confirm actually applies; otherwise the guard
      // blocks and the row stays pending forever.
      if (row.state === 'pending') {
        const claimed = await markPayoutSubmitted(row.id);
        if (claimed === null) {
          return 'skippedRace';
        }
      }
      const confirmed = await markPayoutConfirmed({ id: row.id, txHash: prior.txHash });
      if (confirmed === null) {
        // Another worker already transitioned.
        return 'skippedRace';
      }
      log.info(
        { payoutId: row.id, txHash: prior.txHash, priorState: row.state },
        'Payout converged via idempotency check — prior submit had landed',
      );
      return 'skippedAlreadyLanded';
    }
  } catch (err) {
    log.warn(
      { err, payoutId: row.id },
      'Idempotency pre-check failed — leaving payout untouched for a later retry',
    );
    // Fail closed. Without a trustworthy idempotency read we cannot
    // safely distinguish "needs first submit" from "prior submit
    // landed and the read path is degraded". Leaving the row in its
    // current state avoids the double-pay path; observability and
    // stale-row handling decide when an operator needs to intervene.
    return 'retriedLater';
  }

  // Claim the row before re-submitting. Two paths:
  //   - `pending`: existing markPayoutSubmitted moves pending →
  //     submitted + bumps attempts.
  //   - `submitted` (A2-602 watchdog): row has been sitting past
  //     staleSeconds. Re-claim with a CAS on attempts so two racing
  //     workers don't both re-submit; bumps attempts + fresh
  //     submittedAt while leaving state in 'submitted'.
  let claimed: PendingPayout | null;
  if (row.state === 'pending') {
    claimed = await markPayoutSubmitted(row.id);
    if (claimed === null) {
      return 'skippedRace';
    }
  } else {
    // state === 'submitted' — watchdog re-pick.
    claimed = await reclaimSubmittedPayout({
      id: row.id,
      expectedAttempts: row.attempts,
    });
    if (claimed === null) {
      return 'skippedRace';
    }
    log.warn(
      { payoutId: row.id, attempts: claimed.attempts },
      'Payout watchdog re-picked stuck submitted row',
    );
  }

  try {
    // A2-1921 fee-bump: scale the fee per attempt so a congested
    // network drains naturally instead of going terminal at base
    // fee. `claimed.attempts` is the post-increment counter from
    // markPayoutSubmitted, so it's already the attempt-number we're
    // about to make.
    const feeStroops = feeForAttempt(claimed.attempts, {
      baseFeeStroops: env.LOOP_PAYOUT_FEE_BASE_STROOPS,
      capFeeStroops: env.LOOP_PAYOUT_FEE_CAP_STROOPS,
      multiplier: env.LOOP_PAYOUT_FEE_MULTIPLIER,
    });
    const { txHash } = await submitPayout({
      secret: args.operatorSecret,
      horizonUrl: args.horizonUrl,
      networkPassphrase: args.networkPassphrase,
      feeStroops,
      intent: {
        to: row.toAddress,
        assetCode: row.assetCode,
        assetIssuer: row.assetIssuer,
        amountStroops: row.amountStroops,
        memoText: row.memoText,
      },
    });
    const confirmed = await markPayoutConfirmed({ id: row.id, txHash });
    if (confirmed === null) {
      // Another worker / admin retry beat us to the confirm. Treat
      // as a race rather than an error — the payment did land.
      log.info({ payoutId: row.id, txHash }, 'Payout confirmed by concurrent writer');
      return 'skippedRace';
    }
    log.info({ payoutId: row.id, txHash }, 'Payout confirmed');
    return 'confirmed';
  } catch (err) {
    return handleSubmitError(row, err, args.maxAttempts);
  }
}

async function handleSubmitError(
  row: PendingPayout,
  err: unknown,
  maxAttempts: number,
): Promise<PayOutcome> {
  // After markPayoutSubmitted the attempts counter is already
  // incremented (the +1 that just happened). So when we compare
  // against maxAttempts we're asking "have we used up our budget?".
  const usedAttempts = row.attempts + 1;
  const reason = err instanceof Error ? err.message : 'submitPayout threw without a message';

  if (err instanceof PayoutSubmitError) {
    const isTransient = err.kind === 'transient_horizon' || err.kind === 'transient_rebuild';
    if (isTransient && usedAttempts < maxAttempts) {
      log.warn(
        { payoutId: row.id, kind: err.kind, attempts: usedAttempts, maxAttempts },
        'Transient payout failure — leaving in submitted for retry',
      );
      return 'retriedLater';
    }
    // Terminal, or transient but out of retries.
    await markPayoutFailed({ id: row.id, reason: `[${err.kind}] ${reason}` });
    log.error({ payoutId: row.id, kind: err.kind, attempts: usedAttempts }, 'Payout marked failed');
    notifyPayoutFailed({
      payoutId: row.id,
      userId: row.userId,
      orderId: row.orderId,
      assetCode: row.assetCode,
      amount: row.amountStroops.toString(),
      kind: err.kind,
      reason,
      attempts: usedAttempts,
    });
    return 'failed';
  }

  // Unclassified throw — fail loud.
  await markPayoutFailed({ id: row.id, reason });
  log.error({ payoutId: row.id, err }, 'Payout failed with unclassified error');
  notifyPayoutFailed({
    payoutId: row.id,
    userId: row.userId,
    orderId: row.orderId,
    assetCode: row.assetCode,
    amount: row.amountStroops.toString(),
    kind: 'unclassified',
    reason,
    attempts: usedAttempts,
  });
  return 'failed';
}
