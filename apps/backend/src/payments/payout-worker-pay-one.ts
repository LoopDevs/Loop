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

/**
 * FT-05: on-chain lifetime of a submitted payout tx.
 *
 * `submitPayout` builds every transaction with a hard 60s timebound
 * (`setTimeout(60)` — its `timeoutSeconds` default, which the worker
 * never overrides). A tx signed at a row's `submittedAt` can therefore
 * only be sealed into a ledger within `PAYOUT_SUBMIT_TIMEBOUND_SECONDS`
 * of that stamp; past it Stellar rejects the tx (`tx_too_late`) and it
 * can NEVER land. Keep in sync with `payout-submit.ts`'s default.
 */
const PAYOUT_SUBMIT_TIMEBOUND_SECONDS = 60;
/**
 * Safety margin added to the timebound before a prior in-flight tx is
 * treated as provably dead: covers wall-clock skew between machines and
 * the `loadAccount` round-trip between the `submittedAt` stamp and the
 * actual tx build (the tx's timebound starts a beat AFTER `submittedAt`).
 */
const PAYOUT_SUBMIT_EXPIRY_MARGIN_SECONDS = 30;

/**
 * FT-05: has the prior submit's on-chain transaction provably expired?
 *
 * A re-picked `submitted` row that still carries a persisted `txHash`
 * whose authoritative Horizon lookup is a 404 is AMBIGUOUS: the prior
 * tx is either genuinely never-landed OR still in-flight (submitted to
 * the network, not yet sealed into a ledger). Re-submitting a fresh tx
 * while a prior one can still land is a DOUBLE-SPEND. This returns true
 * only once enough time has elapsed since the row's last `submittedAt`
 * that the prior tx's timebound has certainly passed — at which point a
 * 404 genuinely means "never landed" and a fresh submit is safe.
 *
 * Fail-closed: a row with no `submittedAt` (which a genuine `submitted`
 * row never has — `markPayoutSubmitted`/`reclaimSubmittedPayout` always
 * stamp it) gives no timing basis, so it is treated as NOT expired.
 */
function priorSubmitProvablyExpired(row: PendingPayout): boolean {
  const submittedAt = row.submittedAt;
  if (!(submittedAt instanceof Date)) return false;
  const elapsedMs = Date.now() - submittedAt.getTime();
  const guardSeconds = PAYOUT_SUBMIT_TIMEBOUND_SECONDS + PAYOUT_SUBMIT_EXPIRY_MARGIN_SECONDS;
  return elapsedMs >= guardSeconds * 1000;
}

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
  /**
   * ADR 031 / ADR 036 Phase D: per-asset issuer signers, keyed by
   * LOOP asset code. `kind='interest_mint'` rows are payments FROM
   * the issuer account (a native mint), so they sign with the
   * issuer keypair instead of the operator's — and the idempotency
   * pre-check scans the issuer's payment history accordingly. Every
   * other kind keeps the operator path byte-identical. Resolved in
   * `resolvePayoutConfig` (boot-validated against the configured
   * issuer addresses); absent/empty leaves `interest_mint` rows
   * pending until the secrets are configured.
   */
  issuerSigners?: ReadonlyMap<string, { secret: string; account: string }> | undefined;
  horizonUrl: string;
  networkPassphrase: string;
  maxAttempts: number;
  /**
   * ADR 044 / S4-1: the channel account (if any) this call's shard is
   * bound to. Threaded straight through to `submitPayout` — `payOne`
   * itself doesn't branch on it anywhere else (the idempotency
   * pre-check and CAS claim are unaffected by which account paid the
   * fee). Unset on the legacy no-channel path, so every existing
   * caller is unaffected.
   */
  channelSecret?: string | undefined;
}

/**
 * Per-row signer selection (ADR 031). Returns null when the row
 * needs an issuer signer that isn't configured (or whose validated
 * account no longer matches the row's pinned issuer — e.g. the env
 * was re-pointed after the row was written): the row must stay
 * pending rather than sign with the wrong key.
 */
function resolveRowSigner(
  row: PendingPayout,
  args: PayOneArgs,
): { secret: string; account: string } | null {
  if (row.kind !== 'interest_mint') {
    return { secret: args.operatorSecret, account: args.operatorAccount };
  }
  const signer = args.issuerSigners?.get(row.assetCode);
  if (signer === undefined || signer.account !== row.assetIssuer) {
    return null;
  }
  return signer;
}

/**
 * Trustline pre-flight for user-addressed payouts. Returns a
 * `PayOutcome` when the row should NOT proceed to submit this tick
 * (missing trustline, Horizon degraded), or `null` when the
 * destination is ready. Extracted so `payOne` can skip it entirely
 * for ADR 036 issuer-return burns.
 */
async function probeTrustline(row: PendingPayout): Promise<PayOutcome | null> {
  const trustlineSnapshot = await getAccountTrustlines(row.toAddress).catch((err: unknown) => {
    // Horizon read-degraded path: don't burn the row, retry next
    // tick. Same posture as the idempotency pre-check — fail closed.
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
  return null;
}

export async function payOne(row: PendingPayout, args: PayOneArgs): Promise<PayOutcome> {
  // FT-compensate-guard (liveness): resolve a retry-EXHAUSTED submitted
  // row (`attempts >= maxAttempts`) that still carries a persisted tx hash
  // WITHOUT re-entering the submit pipeline. Such a row is one whose final
  // `transient_horizon` attempt was DEFERRED by `handleSubmitError` (rather
  // than compensated) because its persisted tx was still in-flight-ambiguous
  // (404) and compensating an in-flight payout would double-pay. It has no
  // attempts left, so it must NOT re-submit — the exhausted-reclaim clause in
  // `listClaimablePayouts` re-picks it here purely so we can resolve it off
  // its persisted hash: landed → confirm; still in-flight & not provably
  // expired → keep deferring (no re-submit); provably dead (sealed-FAILED or
  // 404 past its timebound) → terminalize + auto-compensate. This is the LIVE
  // compensate-after-expiry path that keeps the in-flight defer from wedging a
  // genuinely-failed payout in `submitted` forever (a normal watchdog re-pick
  // can't reach it — the base claimable clause excludes `attempts >= max`).
  // Runs BEFORE the trustline probe: a persisted-hash row already cleared the
  // trustline at submit time, and we are converging/terminalizing, not paying.
  if (row.state === 'submitted' && row.txHash !== null && row.attempts >= args.maxAttempts) {
    return resolveExhaustedInFlightPayout(row);
  }
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
  //
  // ADR 036 burn rows are exempt: their destination IS the asset's
  // issuer account, and an issuer never holds (or needs) a trustline
  // to its own asset — Stellar always accepts an asset back at its
  // issuer, where it is burned. Probing would report "no trustline"
  // and park the burn in pending forever.
  const isIssuerReturn = row.toAddress === row.assetIssuer;
  if (!isIssuerReturn) {
    const outcome = await probeTrustline(row);
    if (outcome !== null) return outcome;
  }
  // ADR 031: pick the signing keypair per row. Interest mints sign
  // with (and pre-check against) the asset's ISSUER account — an
  // issuer payment is a native mint; everything else keeps the
  // operator path exactly as before. A missing/mismatched issuer
  // signer leaves the row pending: signing a "mint" with any other
  // key would transfer from an unrelated account.
  const signer = resolveRowSigner(row, args);
  if (signer === null) {
    log.warn(
      { payoutId: row.id, kind: row.kind, assetCode: row.assetCode },
      'No validated issuer signer for interest mint — leaving payout in pending until LOOP_STELLAR_*_ISSUER_SECRET is configured',
    );
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
  // A4-104: scan the SIGNER's account, not row.assetIssuer — that
  // collapses for any treasury topology that splits issuer (cold)
  // from operator (hot), so the pre-check would scan the wrong
  // history and miss prior submits, opening a double-pay path. For
  // interest mints the signer IS the issuer (ADR 031); for every
  // other kind the signer is the operator, same as before.
  try {
    if (row.txHash !== null) {
      const landed = await getOutboundPaymentByTxHash(row.txHash);
      if (landed?.landed === true) {
        return await convergeConfirmed(row, row.txHash, 'authoritative-hash');
      }
      // FT-05: a 404 (`landed === null`) is AMBIGUOUS — the persisted tx
      // is either genuinely never-landed OR still in-flight (submitted to
      // the network, not yet sealed into a ledger). Re-submitting a fresh
      // tx while a prior one can still land is a DOUBLE-SPEND. Only fall
      // through to re-submit once the prior tx's on-chain timebound has
      // provably expired (so a 404 truly means "never landed"); until then
      // fail closed and let a later tick resolve it — the prior tx either
      // lands (the authoritative check then converges → confirmed) or
      // expires (this guard clears and the re-submit proceeds safely).
      // This makes the double-spend guard a real state/lease check rather
      // than an implicit coupling to whatever `watchdogStaleSeconds` an
      // operator happens to configure.
      //
      // `landed === false` needs no wait: that exact tx is sealed on-chain
      // as FAILED, moved no value, and can never succeed later, so a fresh
      // submit (new sequence) can't collide with it.
      if (landed === null && !priorSubmitProvablyExpired(row)) {
        log.warn(
          { payoutId: row.id, txHash: row.txHash, submittedAt: row.submittedAt },
          'Re-picked payout has a persisted tx hash Horizon cannot yet locate (404) and its prior submit may still be in flight — deferring re-submit to avoid a double-spend',
        );
        return 'retriedLater';
      }
    }
    const prior = await findOutboundPaymentByMemo({
      account: signer.account,
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

  let txHash: string;
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
    ({ txHash } = await submitPayout({
      secret: signer.secret,
      ...(args.channelSecret !== undefined ? { channelSecret: args.channelSecret } : {}),
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
    }));
  } catch (err) {
    // Only a genuine SUBMIT failure lands here — the tx did not (provably)
    // go out, so classify-and-retry / fail is safe. The confirm bookkeeping
    // below is deliberately OUTSIDE this catch (FT-01).
    return handleSubmitError(row, err, args.maxAttempts);
  }

  // FT-01: `submitPayout` has RETURNED a landed tx hash — the payment IS
  // on-chain. Everything below is confirm bookkeeping. A failure here must
  // NEVER be routed through `handleSubmitError`: that path misclassifies
  // it as a submit failure and auto-compensates the user
  // (autoCompensateFailedWithdrawal), re-crediting an emission that was
  // already paid on-chain — a DOUBLE-PAY. The deterministic hash was
  // persisted via `onSigned` BEFORE the network submit, so a confirm that
  // throws leaves the row in `submitted` with its hash, and the next
  // watchdog re-pick converges it via the authoritative-hash idempotency
  // check. Reconcile/alert, do not compensate.
  try {
    const confirmed = await markPayoutConfirmed({ id: row.id, txHash });
    if (confirmed === null) {
      // Another worker / admin retry beat us to the confirm. Treat
      // as a race rather than an error — the payment did land.
      log.info({ payoutId: row.id, txHash }, 'Payout confirmed by concurrent writer');
      return 'skippedRace';
    }
    log.info({ payoutId: row.id, txHash }, 'Payout confirmed');
    return 'confirmed';
  } catch (confirmErr) {
    log.error(
      { err: confirmErr, payoutId: row.id, txHash },
      'Payout SUBMITTED on-chain but confirm bookkeeping threw — leaving row in submitted with its persisted tx hash for the watchdog to converge; NOT failing/compensating (the payment already landed; re-paying would double-spend)',
    );
    return 'retriedLater';
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

/**
 * FT-compensate-guard (liveness): resolve a retry-EXHAUSTED `submitted`
 * row that carries a persisted tx hash, WITHOUT re-submitting.
 *
 * Reached only from the early return in `payOne` for a row the
 * exhausted-reclaim clause in `listClaimablePayouts` re-picked
 * (`state='submitted' AND txHash IS NOT NULL AND attempts >= maxAttempts`).
 * Such a row's last `transient_horizon` attempt was DEFERRED rather than
 * compensated to avoid double-paying an in-flight tx; this is where it
 * finally converges or terminalizes off the authoritative hash:
 *
 *   - landed === true  → the tx settled after all: converge → confirmed,
 *     NEVER compensated (a double-pay). (Also recovers an FT-01 confirm-
 *     throw that happened on the final attempt.)
 *   - landed === null && NOT provably expired → still in flight: keep
 *     deferring (retriedLater). No re-submit, no re-claim — so `submittedAt`
 *     is left untouched and the expiry clock keeps advancing across ticks
 *     until the timebound passes.
 *   - landed === false (sealed-FAILED, moved no value) OR
 *     landed === null && provably expired (never landed, timebound passed)
 *     → the prior tx is provably dead: terminalize (fail + auto-compensate).
 *
 * A landed-check that itself throws is treated as `landed === null`
 * (ambiguous → defer), so a Horizon blip can never tip an in-flight tx into
 * a premature compensation.
 */
async function resolveExhaustedInFlightPayout(row: PendingPayout): Promise<PayOutcome> {
  const txHash = row.txHash;
  if (txHash === null) {
    // Defensive: the caller guards `row.txHash !== null`, so this is
    // unreachable. Leave the row for a later tick rather than terminalize a
    // row we can't prove anything about.
    return 'retriedLater';
  }
  const landed = await getOutboundPaymentByTxHash(txHash).catch((err: unknown) => {
    log.warn(
      { err, payoutId: row.id, txHash },
      'FT-compensate-guard: authoritative landed-check failed while resolving an exhausted in-flight payout — treating as unresolved (deferring) so a Horizon blip cannot tip an in-flight tx into a premature compensation',
    );
    return null;
  });
  if (landed?.landed === true) {
    log.warn(
      { payoutId: row.id, txHash },
      'FT-compensate-guard: exhausted in-flight payout LANDED after all — converging to confirmed, never compensating',
    );
    const confirmed = await markPayoutConfirmed({ id: row.id, txHash });
    return confirmed === null ? 'skippedRace' : 'skippedAlreadyLanded';
  }
  if (landed === null && !priorSubmitProvablyExpired(row)) {
    log.warn(
      { payoutId: row.id, txHash, submittedAt: row.submittedAt },
      'FT-compensate-guard: exhausted in-flight payout still 404 and not yet provably expired — deferring again (no re-submit) until its timebound passes',
    );
    return 'retriedLater';
  }
  // landed === false (sealed on-chain as FAILED — moved no value) OR
  // landed === null && provably expired (never landed, timebound has passed):
  // the prior tx is provably dead, so it is finally safe to terminalize.
  const reason =
    landed?.landed === false
      ? 'prior submit sealed on-chain as FAILED — moved no value (retry-exhausted)'
      : 'prior submit provably expired without landing (retry-exhausted)';
  log.error(
    { payoutId: row.id, txHash, sealedFailed: landed?.landed === false, attempts: row.attempts },
    'FT-compensate-guard: exhausted in-flight payout is provably dead — marking failed + auto-compensating',
  );
  return terminalizeFailedPayout(row, 'transient_horizon', reason, row.attempts);
}

/**
 * Terminal-fail bookkeeping shared by `handleSubmitError` (a submit that
 * classified as terminal / out-of-retries) and `resolveExhaustedInFlightPayout`
 * (a deferred exhausted row whose tx proved dead): mark the row `failed`,
 * page ops, and auto-compensate a legacy-debited withdrawal. `markPayoutFailed`
 * + `autoCompensateFailedWithdrawal` both persist the `[kind] reason` tag; the
 * Discord alert carries the plain `reason`. Only ever called once the tx is
 * proven NOT to have moved value — never on an in-flight-ambiguous row.
 */
async function terminalizeFailedPayout(
  row: PendingPayout,
  kind: string,
  reason: string,
  attempts: number,
): Promise<'failed'> {
  const taggedReason = `[${kind}] ${reason}`;
  await markPayoutFailed({ id: row.id, reason: taggedReason });
  log.error({ payoutId: row.id, kind, attempts }, 'Payout marked failed');
  notifyPayoutFailed({
    payoutId: row.id,
    userId: row.userId,
    orderId: row.orderId,
    payoutKind: row.kind,
    assetCode: row.assetCode,
    amount: row.amountStroops.toString(),
    kind,
    reason,
    attempts,
  });
  await autoCompensateFailedWithdrawal(row, taggedReason);
  return 'failed';
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
          // A landed-check that itself fails is no less AMBIGUOUS than a 404:
          // treat it as `landed === null` and let the FT-compensate-guard below
          // decide — defer while the tx may still be in flight, only compensate
          // once its timebound has provably passed. (Before the guard existed
          // this fell straight through to fail+compensate, which is exactly the
          // in-flight double-pay the guard now closes.)
          log.warn(
            { payoutId: row.id, err: checkErr },
            'CF2-07: authoritative landed-check itself failed on ambiguous retry-exhaustion — treating as unresolved (landed === null); the expiry guard decides whether to defer or compensate',
          );
          return null;
        });
        if (landed?.landed === true) {
          log.warn(
            { payoutId: row.id, txHash: fresh.txHash },
            'CF2-07: ambiguous transient_horizon failure at retry-exhaustion actually landed — converging to confirmed instead of failing/compensating',
          );
          // BK-retryexh: the row was already CLAIMED before the submit (it
          // is `submitted` in the DB by the time we reach handleSubmitError
          // — `payOne` returns skippedRace earlier if the claim lost), so
          // confirm it DIRECTLY. `convergeConfirmed` keys its "claim first?"
          // step off the STALE in-memory `row.state`, which is still
          // `pending` for a freshly-claimed row; that would no-op its
          // `markPayoutSubmitted` CAS and leave this LANDED payout stuck in
          // `submitted` / mislabelled `skippedRace` instead of terminally
          // `confirmed`. `markPayoutConfirmed` is state-guarded on
          // `submitted`, so it converges the already-claimed row correctly.
          const confirmed = await markPayoutConfirmed({ id: row.id, txHash: fresh.txHash });
          return confirmed === null ? 'skippedRace' : 'skippedAlreadyLanded';
        }
        // FT-compensate-guard: `landed === null` (a 404, or the unreadable
        // landed-check above) at retry-exhaustion is the SAME in-flight
        // ambiguity the FT-05 pre-check guards on the RE-SUBMIT path — the
        // persisted tx is either genuinely never-landed OR still in flight
        // (submitted to the network, not yet sealed into a ledger) and can
        // still land within its 60s timebound. The terminal path below would
        // `markPayoutFailed` + `autoCompensateFailedWithdrawal`, so if the
        // in-flight tx later lands the user is paid on-chain AND compensated =
        // DOUBLE-PAY. Fail closed — defer (retriedLater). We do NOT re-check the
        // timebound here: the claim that preceded THIS submit stamped
        // `submittedAt = NOW` moments ago, so at the exhaustion instant the tx
        // can never already be provably expired — an expiry check here is dead.
        // The row is left `submitted` at `attempts == maxAttempts`; the
        // exhausted-reclaim clause in `listClaimablePayouts` re-picks it and the
        // `resolveExhaustedInFlightPayout` path at the top of `payOne` owns the
        // eventual resolution (land → confirm; timebound expires still-404 →
        // fail + compensate). That is where the LIVE compensate-after-expiry
        // decision lives, so the row cannot wedge.
        //
        // `landed === false` is exempt (falls through): that exact tx is sealed
        // on-chain as FAILED, moved no value, and can never succeed later, so
        // compensating immediately is safe — same posture as the pre-check.
        if (landed === null) {
          log.warn(
            { payoutId: row.id, txHash: fresh.txHash, submittedAt: fresh.submittedAt },
            'FT-compensate-guard: transient_horizon at retry-exhaustion with an in-flight-ambiguous (404) persisted tx that may still land — deferring the terminal fail/compensate to avoid a double-pay; the exhausted-reclaim path re-resolves once the tx lands or its timebound expires',
          );
          return 'retriedLater';
        }
      }
    }

    // Terminal, or transient but out of retries.
    return terminalizeFailedPayout(row, err.kind, reason, usedAttempts);
  }

  // Unclassified throw — fail loud.
  await markPayoutFailed({ id: row.id, reason });
  log.error({ payoutId: row.id, err }, 'Payout failed with unclassified error');
  notifyPayoutFailed({
    payoutId: row.id,
    userId: row.userId,
    orderId: row.orderId,
    payoutKind: row.kind,
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
 * Scope: `kind='emission'` only (pre-ADR-036 `withdrawal`, relabelled
 * by migration 0038). Order-cashback failures are NOT compensated —
 * an unpaid cashback payout means the off-chain ledger credit simply
 * has no on-chain mirror yet (the user keeps the credit; the
 * divergence is a settlement-backlog handled by drift recovery), not
 * a net-negative balance. The primitive itself also refuses any
 * post-ADR-036 emission lacking the legacy at-send debit row — see
 * `credits/payout-compensation.ts`.
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
  if (row.kind !== 'emission') return;
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
