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
import { listClaimablePayouts } from '../credits/pending-payouts.js';
import { payOne } from './payout-worker-pay-one.js';

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
  /**
   * A2-602 watchdog threshold (seconds). Rows stuck in `submitted`
   * past this are re-picked by the worker for an idempotent retry.
   * Defaults to 300s when unset.
   */
  watchdogStaleSeconds?: number;
}

/**
 * Single pass of the payout worker. Safe to call repeatedly;
 * idempotency lives in (a) the state-guarded markSubmitted + (b)
 * the Horizon memo pre-check inside `payOne`.
 */
export async function runPayoutTick(args: RunPayoutTickArgs): Promise<PayoutTickResult> {
  const rows = await listClaimablePayouts({
    limit: args.limit ?? 5,
    staleSeconds: args.watchdogStaleSeconds ?? 300,
    maxAttempts: args.maxAttempts,
  });
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

// `payOne` (the per-row submit pipeline) and `handleSubmitError`
// live in `./payout-worker-pay-one.ts`. The `PayOutcome` type and
// `payOne` are imported at the top of this file for use in
// `runPayoutTick`'s per-row dispatch.

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
  watchdogStaleSeconds?: number;
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
        ...(args.watchdogStaleSeconds !== undefined
          ? { watchdogStaleSeconds: args.watchdogStaleSeconds }
          : {}),
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
  watchdogStaleSeconds: number;
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
    watchdogStaleSeconds: env.LOOP_PAYOUT_WATCHDOG_STALE_SECONDS,
  };
}
