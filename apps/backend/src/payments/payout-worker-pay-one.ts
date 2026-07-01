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
  recordPayoutTxHash,
  type PendingPayout,
} from '../credits/pending-payouts.js';
import { getPayoutForAdmin } from '../credits/pending-payouts-admin.js';
import { findOutboundPaymentByMemo, getOutboundPaymentByTxHash } from './horizon.js';
import { getAccountTrustlines } from './horizon-trustlines.js';
import { submitPayout, PayoutSubmitError } from './payout-submit.js';
import { feeForAttempt } from './fee-strategy.js';
import { notifyPayoutFailed, notifyPayoutAwaitingTrustline } from '../discord.js';
import {
  applyAdminPayoutCompensation,
  AlreadyCompensatedError,
  PayoutNotCompensableError,
} from '../credits/payout-compensation.js';
import { isLoopAssetCode, currencyForLoopAsset } from '@loop/shared';

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
  // async between the last tick and this one, we converge without
  // issuing a second tx.
  //
  // CF-18: two checks, authoritative first.
  //
  //   1. If a prior attempt persisted its tx hash (recordPayoutTxHash
  //      fires before the network submit), ask Horizon DIRECTLY whether
  //      that exact tx landed. A point lookup by hash has NO history
  //      window, so a re-picked stuck payout converges correctly no
  //      matter how many inbound deposits have interleaved on the shared
  //      deposit+operator account. This is the durable fix for the
  //      double-pay window.
  //
  //   2. Fallback to the memo scan only when no hash was persisted (a
  //      crash between sign and persist, or a row created before this
  //      change). The scan is amount+asset matched (P2-1) so a memo
  //      collision can't converge the wrong payment.
  //
  // A4-104: scan the operator account (the signer), not row.assetIssuer
  // — that collapses for a topology splitting cold issuer from hot
  // operator and would scan the wrong history.
  try {
    if (row.txHash !== null) {
      const landed = await getOutboundPaymentByTxHash(row.txHash);
      if (landed?.landed === true) {
        return await convergeConfirmed(row, row.txHash, 'authoritative-hash');
      }
      // landed=false (tx on chain but failed) or null (never landed):
      // fall through to (re-)submit. A new submit builds a fresh tx with
      // a new sequence, so the failed/absent hash won't collide.
    }
    const prior = await findOutboundPaymentByMemo({
      account: args.operatorAccount,
      to: row.toAddress,
      memo: row.memoText,
      expectedAmountStroops: row.amountStroops,
      expectedAssetCode: row.assetCode,
    });
    if (prior !== null) {
      return await convergeConfirmed(row, prior.txHash, 'memo-scan');
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
      // CF-18: persist the deterministic hash BEFORE the network submit
      // so a crash / lost-response after the tx lands is recoverable via
      // the authoritative hash lookup on the next re-pick. A persist
      // failure aborts the submit (throws PayoutSubmitError) — better to
      // retry than to send a tx we can't later prove we sent.
      onSigned: async (signedHash) => {
        const stamped = await recordPayoutTxHash({ id: row.id, txHash: signedHash });
        if (stamped === null) {
          // Row moved out from under us between claim and stamp (another
          // worker confirmed/failed it). Abort: do NOT submit a second
          // tx on a row we no longer own.
          throw new Error('row no longer in submitted state — aborting submit');
        }
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

/**
 * CF-18: converge a row to `confirmed` after an idempotency check
 * proved a prior submit landed. `markPayoutConfirmed` is state-guarded
 * on `submitted`, so a row still in `pending` (e.g. the row never
 * actually claimed because the prior submit happened in an earlier
 * process) must transition → `submitted` first or the confirm no-ops
 * and the row sticks forever. Returns the appropriate `PayOutcome`.
 */
async function convergeConfirmed(
  row: PendingPayout,
  txHash: string,
  via: 'authoritative-hash' | 'memo-scan',
): Promise<PayOutcome> {
  if (row.state === 'pending') {
    const claimed = await markPayoutSubmitted(row.id);
    if (claimed === null) {
      return 'skippedRace';
    }
  }
  const confirmed = await markPayoutConfirmed({ id: row.id, txHash });
  if (confirmed === null) {
    // Another worker already transitioned.
    return 'skippedRace';
  }
  log.info(
    { payoutId: row.id, txHash, priorState: row.state, via },
    'Payout converged via idempotency check — prior submit had landed',
  );
  return 'skippedAlreadyLanded';
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

    // CF2-07 (2026-06-30 cold audit): `transient_horizon` specifically
    // means "we don't know whether the tx landed" (as opposed to
    // `transient_rebuild`, which means the submit never reached the
    // network — no ambiguity). On every OTHER retry, that ambiguity
    // resolves itself on the NEXT `payOne` call via the CF-18
    // authoritative-hash idempotency pre-check at the top of this
    // file. But retry-exhaustion is terminal — there is no next
    // `payOne` call for this row — so without one more check here, an
    // ambiguous failure that actually landed on-chain would get
    // auto-compensated (autoCompensateFailedWithdrawal below),
    // re-crediting a user who was already paid. Re-fetch the row (the
    // `onSigned` hook may have persisted a fresh txHash during THIS
    // attempt, after the in-memory `row` object was read) and ask
    // Horizon directly before treating it as failed.
    if (err.kind === 'transient_horizon') {
      const fresh = await getPayoutForAdmin(row.id);
      if (fresh?.txHash !== null && fresh?.txHash !== undefined) {
        const landed = await getOutboundPaymentByTxHash(fresh.txHash).catch((checkErr: unknown) => {
          log.warn(
            { payoutId: row.id, err: checkErr },
            'CF2-07: authoritative landed-check itself failed on ambiguous retry-exhaustion — falling through to terminal-fail path (fail-closed toward NOT compensating twice is not possible here, so we prefer the existing manual-review path)',
          );
          return null;
        });
        if (landed?.landed === true) {
          log.warn(
            { payoutId: row.id, txHash: fresh.txHash },
            'CF2-07: ambiguous transient_horizon failure at retry-exhaustion actually landed — converging to confirmed instead of failing/compensating',
          );
          return await convergeConfirmed(row, fresh.txHash, 'authoritative-hash');
        }
      }
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
    await autoCompensateFailedWithdrawal(row, `[${err.kind}] ${reason}`);
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
  await autoCompensateFailedWithdrawal(row, reason);
  return 'failed';
}

/**
 * CF-21 (x-flows F5-2): auto-compensate a user whose withdrawal payout
 * terminally failed. `applyAdminWithdrawal` already debited their
 * off-chain balance + queued this row; a terminal on-chain failure
 * leaves them net-negative (debited, no payout) until a human noticed
 * the Discord page and ran the manual compensation. Re-credit
 * automatically via the established ADR-024 §5 primitive.
 *
 * Scope: `kind='withdrawal'` only. Order-cashback failures are NOT
 * compensated — an unpaid cashback payout means the off-chain ledger
 * credit simply has no on-chain mirror yet (the user keeps the credit;
 * the divergence is a settlement-backlog handled by drift recovery),
 * not a net-negative balance. The primitive itself also refuses any
 * non-withdrawal row.
 *
 * Idempotent + non-throwing:
 *   - The primitive's `SELECT ... FOR UPDATE` re-checks `state='failed'
 *     AND compensated_at IS NULL`, so a re-pick / concurrent admin
 *     compensation surfaces `AlreadyCompensatedError` rather than a
 *     double-credit.
 *   - Any throw (the daily admin-write cap, a DB blip) is logged but
 *     swallowed — the row is already terminally `failed` and ops has
 *     been paged via `notifyPayoutFailed`; a compensation blip must
 *     never re-throw out of the worker tick and abort the batch.
 */
async function autoCompensateFailedWithdrawal(row: PendingPayout, reason: string): Promise<void> {
  if (row.kind !== 'withdrawal') return;
  if (!isLoopAssetCode(row.assetCode)) {
    log.error(
      { payoutId: row.id, assetCode: row.assetCode },
      'CF-21: failed withdrawal has non-LOOP asset code — cannot auto-compensate; manual review',
    );
    return;
  }
  const currency = currencyForLoopAsset(row.assetCode);
  // 1 stroop = 0.00001 minor; mirrors the /100_000n factor
  // applyAdminWithdrawal used in reverse. For any row this primitive
  // emitted the conversion is exact (the primitive re-asserts it under
  // the row lock).
  const amountMinor = row.amountStroops / 100_000n;
  try {
    const applied = await applyAdminPayoutCompensation({
      userId: row.userId,
      currency,
      amountMinor,
      payoutId: row.id,
      reason: `auto-compensation: withdrawal payout failed (${reason})`.slice(0, 500),
    });
    log.warn(
      {
        payoutId: row.id,
        userId: row.userId,
        currency,
        amountMinor: amountMinor.toString(),
        newBalanceMinor: applied.newBalanceMinor.toString(),
      },
      'CF-21: failed withdrawal auto-compensated — user re-credited',
    );
  } catch (err) {
    if (err instanceof AlreadyCompensatedError) {
      log.info({ payoutId: row.id }, 'CF-21: failed withdrawal already compensated — no-op');
      return;
    }
    if (err instanceof PayoutNotCompensableError) {
      // The row moved out from under us (a concurrent admin retry reset
      // it, etc.) or a precondition mismatch. Non-fatal at the worker
      // level — ops has been paged via notifyPayoutFailed.
      log.warn(
        { payoutId: row.id, err: err.message },
        'CF-21: auto-compensation precondition not met — leaving for manual review',
      );
      return;
    }
    // Daily-cap hit or a DB blip. Swallow — the row is terminally
    // failed and ops is already paged; do not abort the tick.
    log.error(
      { err, payoutId: row.id },
      'CF-21: auto-compensation threw — user NOT re-credited; manual compensation needed',
    );
  }
}
