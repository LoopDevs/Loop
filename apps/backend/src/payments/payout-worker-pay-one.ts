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
import { submitPayout, PayoutSubmitError } from './payout-submit.js';
import { feeForAttempt } from './fee-strategy.js';
import { notifyPayoutFailed } from '../discord.js';

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
  horizonUrl: string;
  networkPassphrase: string;
  maxAttempts: number;
}

export async function payOne(row: PendingPayout, args: PayOneArgs): Promise<PayOutcome> {
  // Idempotency pre-check (ADR 016). If the prior submit landed
  // async between the last tick and this one, we observe the
  // payment in Horizon history and converge without issuing a
  // second tx. `from` is the operator pubkey we'd sign with; we
  // compute it off the secret via the SDK inside `submitPayout` —
  // to keep `findOutboundPaymentByMemo` pure, we reuse the stored
  // issuer pubkey as the lookup account (invariant: the operator
  // account IS the issuer for LOOP-branded assets).
  //
  // TODO(follow-up): decouple operator pubkey from issuer pubkey
  // once the operator secret is plumbed into its own env var with
  // a separate LOOP_STELLAR_OPERATOR_ACCOUNT public key.
  try {
    const prior = await findOutboundPaymentByMemo({
      account: row.assetIssuer,
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
