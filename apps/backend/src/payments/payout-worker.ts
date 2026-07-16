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
 * No parallelism across rows WITHIN a tick on the SAME account — each
 * row's submit awaits the previous one so that account's sequence
 * numbers serialise. Small batch per tick (default 5) caps outstanding
 * risk.
 *
 * ADR 044 / S4-1: when payout channel accounts are configured
 * (`LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS`), the claimed batch is
 * sharded across them and the shards run concurrently — each shard is
 * still a strictly serial queue against its own channel's sequence
 * number (so the "no parallelism on one sequence" guarantee above
 * holds per-channel), but N channels give N sequence numbers, so N
 * shards can have a submit in flight at once. Zero channels configured
 * (the default) is the exact pre-ADR-044 single-queue path — see
 * `docs/adr/044-payout-throughput.md`.
 *
 * CF-14 (x-concurrency-financial X-2): that single-process serialise
 * assumption does NOT hold across Fly machines — every machine runs
 * this worker (no leader election / `[processes] worker count=1`), and
 * `auto_start_machines=true` boots a second one under load. The row
 * claim now takes `FOR UPDATE SKIP LOCKED` (`listClaimablePayouts`) so
 * two instances pull disjoint candidate sets instead of fighting over
 * the same rows and colliding on the operator sequence number
 * (`tx_bad_seq`). That is a row-level claim, not full leader election:
 * a backlog larger than one batch can still have two instances claim
 * disjoint batches and submit concurrently. `min_machines_running=1`
 * masks the residual today; the single-flight worker is deferred. See
 * `listClaimablePayouts` for the full reasoning.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { isKilled } from '../kill-switches.js';
import { killSwitchService } from '../rail-kill-switches/index.js';
import { withAdvisoryLock } from '../db/client.js';
import { listClaimablePayouts } from '../credits/pending-payouts.js';
import { resolveIssuerSigners } from './issuer-signers.js';
import { resolvePayoutChannels, type ChannelSigner } from './channel-accounts.js';
import {
  runStuckPayoutWatchdog,
  STUCK_PAYOUT_WATCHDOG_INTERVAL_MS,
} from './stuck-payout-watchdog.js';
import { runFailedPayoutBacklogWatchdog } from './failed-payout-backlog-watchdog.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
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
  /**
   * CF-15 (x-flows F9-1): `kind='emission'` rows left untouched
   * because `LOOP_KILL_EMISSIONS` is engaged (pre-ADR-036 this was
   * `withdrawal` / `LOOP_KILL_WITHDRAWALS`). Order-cashback rows
   * keep draining — the kill switch is the operator's "stop outbound
   * user withdrawals NOW" lever (e.g. a leaked-operator-key incident),
   * not a full payout halt.
   */
  skippedKilled: number;
}

export interface RunPayoutTickArgs {
  operatorSecret: string;
  /**
   * A4-104: explicit operator account public key used for the
   * idempotency pre-check (`findOutboundPaymentByMemo`'s `account`
   * filter). Previously the pre-check reused `row.assetIssuer`,
   * which silently double-pays if a treasury topology splits
   * issuer (cold) from operator (hot). Derived from `operatorSecret`
   * in `resolvePayoutConfig` so callers don't have to reproduce the
   * keypair derivation.
   */
  operatorAccount: string;
  /**
   * ADR 031: per-asset issuer signers for `kind='interest_mint'`
   * rows (issuer payment = mint). See `PayOneArgs.issuerSigners`.
   * Optional so operator-only deployments (no on-chain interest)
   * change nothing.
   */
  issuerSigners?: ReadonlyMap<string, { secret: string; account: string }>;
  /**
   * ADR 044 / S4-1: configured payout channel accounts, in order.
   * Empty/omitted (default) → the legacy single-sequence path, every
   * row processed by one serial queue with no `channelSecret` ever
   * passed downstream — byte-identical to pre-ADR-044 behaviour. N
   * channels → the claimed batch is sharded N ways and each shard runs
   * concurrently with the others (still serial within itself). See
   * `runPayoutTickLocked` and `docs/adr/044-payout-throughput.md`.
   */
  channels?: readonly ChannelSigner[];
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
/**
 * Advisory-lock key for the payout-worker leader gate (hardening A8).
 * Fixed sha256→int64 derivation, same shape as the ledger-invariant /
 * adjustment-cap keys. One key fleet-wide → one payout tick runs at a
 * time across all Fly machines.
 */
function payoutLeaderLockKey(): bigint {
  const digest = createHash('sha256').update('loop:payout-worker-leader').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

const EMPTY_TICK: PayoutTickResult = {
  picked: 0,
  confirmed: 0,
  failed: 0,
  skippedAlreadyLanded: 0,
  skippedRace: 0,
  retriedLater: 0,
  skippedKilled: 0,
};

/**
 * Hard ceiling on how long the leader may hold the A8 lock. A batch of
 * 5 submits at ~5s each is ~25s; 90s leaves generous headroom while
 * bounding the worst case. See the deadline rationale in
 * `runPayoutTick`.
 */
const PAYOUT_TICK_LEASE_MS = 90_000;

/** Distinct sentinel so the lease-timeout path is testable + loggable. */
const TICK_LEASE_TIMED_OUT = Symbol('payout-tick-lease-timeout');

export async function runPayoutTick(args: RunPayoutTickArgs): Promise<PayoutTickResult> {
  // NS-04: whole-rail halt. When the payout rail is halted, early-return
  // an empty tick BEFORE acquiring the leader lock or claiming any rows —
  // no new payout is submitted. Block-new-only: claimed rows stay
  // `pending`/`submitted` and re-drain on resume (same posture as the
  // CF-15 emission-skip below, but for the WHOLE rail rather than just
  // `kind='emission'`). Fails CLOSED: an unreadable switch reads as
  // halted, so a DB blip pauses new outbound payments rather than risking
  // them while state is unknown.
  if (await killSwitchService.isHalted('payout')) {
    log.warn('payout rail is halted — skipping payout tick (block-new-only)');
    return { ...EMPTY_TICK };
  }
  // Hardening A8: single-flight the whole claim→submit tick across
  // machines. `SKIP LOCKED` (listClaimablePayouts) already gives
  // disjoint row batches, but two machines submitting concurrently
  // still race the operator account's sequence number (`tx_bad_seq`
  // churn that can burn the attempt budget and drive legit payouts to
  // terminal `failed`). Holding a fleet-wide advisory lock for the
  // whole tick makes the operator-sequence usage serial again.
  //
  // The lock is held across the (network) Stellar submits, so a
  // hung-but-alive leader (a blackholed Horizon that accepts TCP and
  // never responds) would otherwise hold the lock forever and stall
  // the WHOLE fleet's payout queue — a worse failure mode than the
  // per-machine `tx_bad_seq` churn A8 fixes (adversarial-review P1).
  // So the tick body races a hard lease deadline: on timeout we
  // release the lock and return, and the orphaned submit degrades to
  // exactly the pre-A8 per-machine race (the accepted residual), never
  // a fleet stall. Net: strictly better than status quo in the normal
  // case, no worse in the pathological one.
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await withAdvisoryLock(payoutLeaderLockKey(), () =>
    Promise.race([
      runPayoutTickLocked(args),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(() => resolve(TICK_LEASE_TIMED_OUT), PAYOUT_TICK_LEASE_MS);
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!outcome.ran) {
    // Another machine holds the lock this tick.
    return { ...EMPTY_TICK };
  }
  if (outcome.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: PAYOUT_TICK_LEASE_MS },
      'Payout tick exceeded the lease deadline — releasing the leader lock so the fleet is not stalled; the in-flight submit degrades to the pre-A8 per-machine posture',
    );
    return { ...EMPTY_TICK };
  }
  return outcome.value;
}

/** The tick body, run under the A8 leader lock. */
async function runPayoutTickLocked(args: RunPayoutTickArgs): Promise<PayoutTickResult> {
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
    skippedKilled: 0,
  };
  // CF-15 (x-flows F9-1): read the kill switch ONCE per tick (live
  // process.env, like the request-path middleware) so a mid-incident
  // flip takes effect on the next tick without a redeploy. Emission
  // rows are skipped while engaged — they stay `pending`/`submitted`
  // and re-drain once the switch is reset. Order-cashback rows are
  // never gated by this switch (they're not user-initiated outbound
  // transfers — they emit the cashback the user already earned).
  // (Pre-ADR-036 this was the `withdrawals` switch / `kind='withdrawal'`
  // — renamed with the emission re-scope; `kind='burn'` issuer-return
  // rows are likewise never gated, same rationale as order-cashback.)
  const emissionsKilled = isKilled('emissions');

  // ADR 044 / S4-1: shard the claimed batch across configured channel
  // accounts and run the shards concurrently. Partition is a pure
  // in-memory split of THIS process's own already-claimed rows (no
  // second DB claim, so there's nothing for two shards to race on —
  // row i belongs to shard i % shardCount by construction). Each
  // shard is its own strictly-sequential queue — a shard never has two
  // in-flight submits against its own channel — so the "no parallel
  // submits on one sequence number" guarantee holds per-shard exactly
  // as it held fleet-wide pre-ADR-044. Zero channels configured
  // collapses to shardCount=1 with `channelSecret` never set — the
  // exact pre-ADR-044 single-queue loop, unchanged.
  const channels = args.channels ?? [];
  const shardCount = channels.length > 0 ? channels.length : 1;
  const shards: (typeof rows)[number][][] = Array.from({ length: shardCount }, (_unused, i) =>
    rows.filter((_row, rowIndex) => rowIndex % shardCount === i),
  );

  const runShard = async (
    shardRows: (typeof rows)[number][],
    channelSecret: string | undefined,
  ): Promise<void> => {
    for (const row of shardRows) {
      if (emissionsKilled && row.kind === 'emission') {
        result.skippedKilled++;
        continue;
      }
      const outcome = await payOne(row, { ...args, channelSecret });
      // Safe under JS's single-threaded cooperative concurrency: this
      // increment never interleaves with another shard's increment
      // mid-operation, even though multiple `runShard` calls are
      // in-flight together via the `Promise.allSettled` below.
      result[outcome]++;
    }
  };

  // `allSettled`, not `all` (S4-1 follow-up). `payOne` fences almost
  // everything it does in try/catch (idempotency pre-check, submit,
  // classify-and-fail), but the row-claim call (markPayoutSubmitted /
  // reclaimSubmittedPayout) and a couple of handleSubmitError's own DB
  // writes are NOT — an unexpected throw there (DB blip, programmer
  // error) can still reject `payOne`, and with it this shard's
  // `runShard` loop.
  //
  // With `Promise.all`, one rejecting shard rejects the WHOLE tick
  // immediately. That's worse than just losing a row: sibling shards'
  // `runShard` calls are NOT cancelled by the rejection (JS doesn't
  // cancel in-flight promises), so they keep submitting Stellar
  // transactions in the background — but `withAdvisoryLock` releases the
  // fleet-wide A8 leader lock as soon as THIS function's returned
  // promise settles, i.e. immediately on the first shard rejection,
  // while those sibling shards are still mid-submit. A second machine
  // could then acquire the lock and submit through the SAME configured
  // channel accounts concurrently with the still-in-flight orphaned
  // shard — exactly the sequence-number collision (`tx_bad_seq` churn)
  // A8 exists to prevent. So a shard rejection wasn't just a reporting
  // nit; it could reopen the cross-machine race A8 closed.
  //
  // `allSettled` waits for every shard to finish (success or failure)
  // before this function returns, so the lock is held for the shards'
  // full duration regardless of any one shard's outcome — isolating a
  // shard failure's blast radius to its own shard (its unprocessed rows
  // simply stay in their prior DB state and get picked up next tick)
  // without weakening A8 or losing the sibling shards' completed work
  // from this tick's reported counts.
  const settled = await Promise.allSettled(
    shards.map((shardRows, i) => runShard(shardRows, channels[i]?.secret)),
  );
  for (const [shardIndex, outcome] of settled.entries()) {
    if (outcome.status !== 'rejected') continue;
    const shardRows = shards[shardIndex] ?? [];
    log.error(
      {
        err: outcome.reason,
        shardIndex,
        shardCount,
        shardRowCount: shardRows.length,
        shardRowIds: shardRows.map((row) => row.id),
        // Public key only — never the channel secret.
        shardChannelAccount: channels[shardIndex]?.account,
      },
      'Payout channel shard threw and stopped mid-tick — isolated from sibling shards, which still ran to completion and are reflected in this tick’s counts. Rows in shardRowIds already processed before the throw are also reflected; the rest are untouched and will be re-picked on a later tick',
    );
  }

  if (emissionsKilled && result.skippedKilled > 0) {
    log.warn(
      { skippedKilled: result.skippedKilled },
      'LOOP_KILL_EMISSIONS engaged — skipped emission payouts this tick (order-cashback still draining)',
    );
  }
  return result;
}

// `payOne` (the per-row submit pipeline) and `handleSubmitError`
// live in `./payout-worker-pay-one.ts`. The `PayOutcome` type and
// `payOne` are imported at the top of this file for use in
// `runPayoutTick`'s per-row dispatch.

// ─── Interval loop ────────────────────────────────────────────────────────

let payoutTimer: ReturnType<typeof setInterval> | null = null;
let stuckPayoutWatchdogTimer: ReturnType<typeof setInterval> | null = null;

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
  operatorAccount: string;
  issuerSigners?: ReadonlyMap<string, { secret: string; account: string }>;
  /** ADR 044 / S4-1 — see `RunPayoutTickArgs.channels`. */
  channels?: readonly ChannelSigner[];
  horizonUrl: string;
  networkPassphrase: string;
  intervalMs: number;
  maxAttempts: number;
  limit?: number;
  watchdogStaleSeconds?: number;
}): void {
  if (payoutTimer !== null) return;
  markWorkerStarted('payout_worker', { staleAfterMs: Math.max(args.intervalMs * 3, 60_000) });
  log.info(
    { intervalMs: args.intervalMs, channelCount: args.channels?.length ?? 0 },
    'Starting payout worker',
  );
  const tick = async (): Promise<void> => {
    try {
      const r = await runPayoutTick({
        operatorSecret: args.operatorSecret,
        operatorAccount: args.operatorAccount,
        ...(args.issuerSigners !== undefined ? { issuerSigners: args.issuerSigners } : {}),
        ...(args.channels !== undefined ? { channels: args.channels } : {}),
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
      markWorkerTickSuccess('payout_worker');
    } catch (err) {
      markWorkerTickFailure('payout_worker', err);
      log.error({ err }, 'Payout tick failed');
    }
  };
  const watchdog = async (): Promise<void> => {
    try {
      await runStuckPayoutWatchdog();
    } catch (err) {
      log.error({ err }, 'Stuck-payout watchdog failed');
    }
    // NS-12: standing detector for the FAILED-payout backlog. The
    // stuck-payout watchdog above only covers pending/submitted rows; a
    // terminally-failed row is paged once inline at failure and, if that
    // page is lost, would otherwise leave owed cashback/interest
    // invisible forever. Same cadence + fleet single-flight; independent
    // try/catch so one failing check never suppresses the other.
    try {
      await runFailedPayoutBacklogWatchdog();
    } catch (err) {
      log.error({ err }, 'Failed-payout backlog watchdog failed');
    }
  };
  void tick();
  void watchdog();
  payoutTimer = setInterval(() => void tick(), args.intervalMs);
  payoutTimer.unref();
  stuckPayoutWatchdogTimer = setInterval(() => void watchdog(), STUCK_PAYOUT_WATCHDOG_INTERVAL_MS);
  stuckPayoutWatchdogTimer.unref();
}

export function stopPayoutWorker(): void {
  if (stuckPayoutWatchdogTimer !== null) {
    clearInterval(stuckPayoutWatchdogTimer);
    stuckPayoutWatchdogTimer = null;
  }
  if (payoutTimer === null) return;
  clearInterval(payoutTimer);
  payoutTimer = null;
  markWorkerStopped('payout_worker');
  log.info('Payout worker stopped');
}

/** Test seam: returns undefined. Kept to mirror other worker files. */
export function __resetPayoutWorkerForTests(): void {
  if (stuckPayoutWatchdogTimer !== null) {
    clearInterval(stuckPayoutWatchdogTimer);
    stuckPayoutWatchdogTimer = null;
  }
  if (payoutTimer !== null) {
    clearInterval(payoutTimer);
    payoutTimer = null;
  }
}

/** Derives the effective operator config from env. Null when not live. */
export function resolvePayoutConfig(): {
  operatorSecret: string;
  /**
   * A4-104: operator account pubkey derived from the secret at
   * resolve-time. Used for the Horizon idempotency pre-check so
   * the lookup runs against the account that signs (operator),
   * not the issuer of the asset (which may be a separate cold
   * key in production treasury topologies).
   */
  operatorAccount: string;
  /**
   * ADR 031: validated per-asset issuer signers (empty map when no
   * `LOOP_STELLAR_*_ISSUER_SECRET` is configured). `interest_mint`
   * rows sign with these; everything else uses the operator pair.
   */
  issuerSigners: ReadonlyMap<string, { secret: string; account: string }>;
  /**
   * ADR 044 / S4-1: validated payout channel accounts (empty array
   * when `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` is unset — the default,
   * fully-serial legacy path).
   */
  channels: readonly ChannelSigner[];
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
  let operatorAccount: string;
  try {
    operatorAccount = Keypair.fromSecret(env.LOOP_STELLAR_OPERATOR_SECRET).publicKey();
  } catch (err) {
    log.error(
      { err },
      'LOOP_STELLAR_OPERATOR_SECRET is not a valid Stellar secret — payout worker disabled',
    );
    return null;
  }
  return {
    operatorSecret: env.LOOP_STELLAR_OPERATOR_SECRET,
    operatorAccount,
    // parseEnv boot-validated every configured issuer secret against
    // its issuer address, so this resolve cannot throw at this point.
    issuerSigners: resolveIssuerSigners(),
    // parseEnv boot-validated every configured channel secret (format +
    // no collision with operator/issuer accounts), so this resolve
    // cannot throw at this point either.
    channels: resolvePayoutChannels(),
    horizonUrl,
    networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
    maxAttempts: env.LOOP_PAYOUT_MAX_ATTEMPTS,
    intervalMs: env.LOOP_PAYOUT_WORKER_INTERVAL_SECONDS * 1000,
    watchdogStaleSeconds: env.LOOP_PAYOUT_WATCHDOG_STALE_SECONDS,
  };
}
