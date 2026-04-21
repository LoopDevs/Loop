/**
 * Payout worker (ADR 016).
 *
 * Drains `pending_payouts` rows FIFO, ticks each through the
 * ADR 016 submit pipeline:
 *
 *   1. Pre-flight idempotency check (findOutboundPaymentByMemo):
 *      if a prior submit already landed async, converge to
 *      `confirmed` without issuing a second tx.
 *   2. markPayoutSubmitted → state-guarded transition, bumps
 *      attempts. If null, another worker already claimed the row.
 *   3. submitPayout → SDK sign + submit. Fresh seq per call.
 *   4. Success → markPayoutConfirmed({ txHash }).
 *   5. Failure → classify:
 *        - transient + under the attempts cap → leave in submitted,
 *          idempotency check on the next tick will converge or
 *          the retry will rebuild with fresh seq.
 *        - transient + at/over the cap → markPayoutFailed (ops
 *          gets the admin-retry path).
 *        - terminal → markPayoutFailed immediately.
 *
 * No parallelism across rows — the operator account's sequence
 * numbers serialise, so two in-flight submits would race. Small
 * batch per tick (default 5) caps outstanding risk.
 *
 * Not wired into `index.ts` yet — the interval loop lands alongside
 * the payment watcher + procurement worker once an operator has
 * dry-run on testnet.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import {
  listPendingPayouts,
  markPayoutSubmitted,
  markPayoutConfirmed,
  markPayoutFailed,
  type PendingPayout,
} from '../credits/pending-payouts.js';
import { findOutboundPaymentByMemo } from './horizon.js';
import { submitPayout, PayoutSubmitError } from './payout-submit.js';
import { notifyPayoutFailed } from '../discord.js';

const log = logger.child({ area: 'payout-worker' });

export interface PayoutTickResult {
  picked: number;
  confirmed: number;
  failed: number;
  /** Rows where the idempotency check found a prior submit had landed. */
  skippedAlreadyLanded: number;
  /** Rows where another worker beat us to the markSubmitted. */
  skippedRace: number;
  /** Transient failures left in submitted for the next tick to retry. */
  retriedLater: number;
}

export interface RunPayoutTickArgs {
  operatorSecret: string;
  horizonUrl: string;
  networkPassphrase: string;
  maxAttempts: number;
  limit?: number;
}

/**
 * Single pass of the payout worker. Safe to call repeatedly;
 * idempotency lives in (a) the state-guarded markSubmitted + (b)
 * the Horizon memo pre-check inside `payOne`.
 */
export async function runPayoutTick(args: RunPayoutTickArgs): Promise<PayoutTickResult> {
  const rows = await listPendingPayouts(args.limit ?? 5);
  const result: PayoutTickResult = {
    picked: rows.length,
    confirmed: 0,
    failed: 0,
    skippedAlreadyLanded: 0,
    skippedRace: 0,
    retriedLater: 0,
  };
  for (const row of rows) {
    const outcome = await payOne(row, args);
    result[outcome]++;
  }
  return result;
}

type PayOutcome = 'confirmed' | 'failed' | 'skippedAlreadyLanded' | 'skippedRace' | 'retriedLater';

async function payOne(row: PendingPayout, args: RunPayoutTickArgs): Promise<PayOutcome> {
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
      const confirmed = await markPayoutConfirmed({ id: row.id, txHash: prior.txHash });
      if (confirmed === null) {
        // Another worker already transitioned.
        return 'skippedRace';
      }
      log.info(
        { payoutId: row.id, txHash: prior.txHash },
        'Payout converged via idempotency check — prior submit had landed',
      );
      return 'skippedAlreadyLanded';
    }
  } catch (err) {
    log.warn(
      { err, payoutId: row.id },
      'Idempotency pre-check failed — proceeding to submit anyway',
    );
    // A Horizon read failure on the pre-check isn't terminal — the
    // submit itself will either succeed or throw with its own
    // classification. Worst case: we submit + the prior landed too,
    // but Horizon dedupes on the signed envelope so the duplicate
    // resolves to the same tx hash.
  }

  const claimed = await markPayoutSubmitted(row.id);
  if (claimed === null) {
    return 'skippedRace';
  }

  try {
    const { txHash } = await submitPayout({
      secret: args.operatorSecret,
      horizonUrl: args.horizonUrl,
      networkPassphrase: args.networkPassphrase,
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

// ─── Interval loop ────────────────────────────────────────────────────────

let payoutTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic payout worker. Gated at the caller by
 * `LOOP_WORKERS_ENABLED` + `LOOP_STELLAR_OPERATOR_SECRET` — this
 * function trusts that both are set.
 *
 * Swallows per-tick errors so a transient Horizon / DB blip
 * doesn't kill the interval; next tick retries.
 */
export function startPayoutWorker(args: {
  operatorSecret: string;
  horizonUrl: string;
  networkPassphrase: string;
  intervalMs: number;
  maxAttempts: number;
  limit?: number;
}): void {
  if (payoutTimer !== null) return;
  log.info({ intervalMs: args.intervalMs }, 'Starting payout worker');
  const tick = async (): Promise<void> => {
    try {
      const r = await runPayoutTick({
        operatorSecret: args.operatorSecret,
        horizonUrl: args.horizonUrl,
        networkPassphrase: args.networkPassphrase,
        maxAttempts: args.maxAttempts,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (r.picked > 0) {
        log.info(r, 'Payout tick complete');
      }
    } catch (err) {
      log.error({ err }, 'Payout tick failed');
    }
  };
  void tick();
  payoutTimer = setInterval(() => void tick(), args.intervalMs);
  payoutTimer.unref();
}

export function stopPayoutWorker(): void {
  if (payoutTimer === null) return;
  clearInterval(payoutTimer);
  payoutTimer = null;
  log.info('Payout worker stopped');
}

/** Test seam: returns undefined. Kept to mirror other worker files. */
export function __resetPayoutWorkerForTests(): void {
  if (payoutTimer !== null) {
    clearInterval(payoutTimer);
    payoutTimer = null;
  }
}

/** Derives the effective operator config from env. Null when not live. */
export function resolvePayoutConfig(): {
  operatorSecret: string;
  horizonUrl: string;
  networkPassphrase: string;
  maxAttempts: number;
  intervalMs: number;
} | null {
  if (env.LOOP_STELLAR_OPERATOR_SECRET === undefined) return null;
  const horizonUrl =
    process.env['LOOP_STELLAR_HORIZON_URL'] !== undefined &&
    process.env['LOOP_STELLAR_HORIZON_URL'].length > 0
      ? process.env['LOOP_STELLAR_HORIZON_URL']
      : 'https://horizon.stellar.org';
  return {
    operatorSecret: env.LOOP_STELLAR_OPERATOR_SECRET,
    horizonUrl,
    networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
    maxAttempts: env.LOOP_PAYOUT_MAX_ATTEMPTS,
    intervalMs: env.LOOP_PAYOUT_WORKER_INTERVAL_SECONDS * 1000,
  };
}
