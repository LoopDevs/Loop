/**
 * Asset-drift watcher (ADR 015).
 *
 * Background companion to the admin drift-detection surface
 * (`/admin/assets`, treasury, landing). Polls Horizon for each
 * configured LOOP-branded stablecoin and compares on-chain
 * circulation against the off-chain ledger liability mirror
 * (ADR 036 / ADR 031):
 *
 *   driftStroops = (onChain − pool − unconfirmedBurns + unconfirmedInterestMints)
 *                  − ledgerLiabilityMinor × 1e5
 *
 * When |drift| exceeds a per-operator threshold, pages the
 * monitoring Discord channel so ops notices before an admin happens
 * to refresh the page. Pairs with `notifyPayoutFailed` as the two
 * stablecoin-safety alerts: payout failures catch one-off submit
 * problems; drift catches accounting divergence (systemic
 * over-minting, a stuck payout queue, Horizon-side mistakes).
 *
 * Second alert dimension (hardening A2): burn / interest-mint rows in
 * state `failed` stay inside the equation's un-confirmed terms (the
 * deposit-held tokens / mirror credits genuinely exist), which makes
 * the equation itself permanently blind to them — a terminally-failed
 * nightly mint would read as drift-neutral forever while the user's
 * mirror overstates their on-chain holdings (ADR 036: chain is
 * authoritative). The watcher therefore tracks the failed sums
 * separately and pages on the none→present transition, keeping the
 * masked term loud until an operator retries the rows
 * (`/admin/payouts?state=failed` → reset-to-pending).
 *
 * State is persisted per-asset in Postgres (hardening A3;
 * `asset-drift-state-repo.ts`) so we only notify on transitions
 * (ok → over) and recoveries (over → ok) — fleet-wide, one machine
 * claims each transition's page under the row lock, and a restart no
 * longer re-pages an ongoing incident. Delivery is at-least-once:
 * `last_paged_*` records what ops has actually been paged about,
 * written only after a successful Discord send, so a page lost to an
 * outage or a mid-tick crash stays due and is re-attempted on later
 * ticks rather than silenced forever.
 *
 * Horizon failure per-asset is logged + skipped; we do NOT flip
 * state on a read failure so a 30s Horizon blip doesn't page as a
 * spurious recovery. The admin UI keeps the same invariant
 * (ledger-side stays authoritative when Horizon is down).
 */
import { createHash } from 'node:crypto';
import { withAdvisoryLock } from '../db/client.js';
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { sumOutstandingLiability } from '../credits/liabilities.js';
import {
  sumBurnStroopsByState,
  sumInterestMintStroopsByState,
} from '../credits/pending-payouts.js';
import { getLoopAssetCirculation } from './horizon-circulation.js';
import { getAssetBalance } from './horizon-asset-balance.js';
import { resolveInterestPoolAccount } from '../credits/interest-pool.js';
import {
  applyDriftState,
  listPersistedDriftStates,
  markPagesDelivered,
  releasePageLease,
  type DuePages,
} from './asset-drift-state-repo.js';
import {
  notifyAssetDrift,
  notifyAssetDriftRecovered,
  notifyDriftFailedRows,
  notifyDriftFailedRowsCleared,
} from '../discord.js';
import { logger } from '../logger.js';
import { setMoneyIntegrityBreach } from '../metrics.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSkippedLocked,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import type { HomeCurrency } from '@loop/shared';

const log = logger.child({ area: 'asset-drift-watcher' });

/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

// A2-1506: the literal union is `AssetDriftState` in `@loop/shared`.
// Re-export under the `DriftState` alias so in-file code keeps
// resolving (the watcher predates the shared type).
import type { AssetDriftState, AssetFailedRowsState } from '@loop/shared';
export type DriftState = AssetDriftState;

/**
 * Full per-asset snapshot — the transition states plus the raw
 * numbers from the last successful read. Backed by the persisted
 * `asset_drift_state` row (A3), so the admin state endpoint surfaces
 * the same fleet-wide values from any machine.
 */
export interface DriftAssetSnapshot {
  state: DriftState;
  /** Last drift in stroops. `null` until this asset has been read at least once. */
  lastDriftStroops: bigint | null;
  /** Threshold used for the last comparison (stroops). */
  lastThresholdStroops: bigint | null;
  /** Unix ms of the last successful per-asset read. */
  lastCheckedMs: number | null;
  /** Failed burn / interest-mint dimension (hardening A2). */
  failedRowsState: AssetFailedRowsState;
  /** Stroops on `kind='burn'` rows in state `failed`. `null` pre-first-read. */
  failedBurnStroops: bigint | null;
  /** Stroops on `kind='interest_mint'` rows in state `failed`. `null` pre-first-read. */
  failedInterestMintStroops: bigint | null;
}

let lastTickMs: number | null = null;

export interface AssetDriftSample {
  assetCode: LoopAssetCode;
  /**
   * Drift after subtracting the interest forward-mint pool balance
   * and the un-confirmed redemption burns from on-chain circulation
   * (and adding un-confirmed interest mints). See `runAssetDriftTick`
   * doc-comment for the reconciliation equation.
   */
  driftStroops: bigint;
  /**
   * Raw on-chain stroops issued by the LOOP-asset issuer (held by
   * non-issuer accounts including users + the interest pool).
   * Surfaced separately from `driftStroops` so the admin treasury
   * surface can show "X issued, Y in pool, Z out to users."
   */
  onChainStroops: bigint;
  /**
   * Stroops sitting in the interest forward-mint pool. `0n` when
   * the pool isn't configured or the trustline is missing.
   */
  poolStroops: bigint;
  /**
   * ADR 036: stroops debited from the mirror at redemption and
   * parked at the deposit account awaiting the issuer-return burn
   * (`pending_payouts` kind='burn', state pending/submitted).
   * Counted out of circulation so a redemption doesn't read as
   * drift between the mirror debit and the burn confirming.
   * Terminally-failed burn rows are in {@link failedBurnStroops}.
   */
  pendingBurnStroops: bigint;
  /**
   * Hardening A2: stroops on `kind='burn'` rows in state `failed`.
   * Still subtracted from circulation (the tokens are genuinely
   * parked at the deposit account) but tracked as the failed-rows
   * alert dimension — these only converge via an operator retry.
   */
  failedBurnStroops: bigint;
  /**
   * ADR 031: stroops credited to the mirror by the nightly interest
   * txn but whose issuer-signed on-chain mint hasn't confirmed yet
   * (`pending_payouts` kind='interest_mint', state pending/
   * submitted). Counted INTO circulation so an in-flight mint
   * doesn't read as drift between the mirror credit and the mint
   * confirming. Terminally-failed mint rows are in
   * {@link failedInterestMintStroops}.
   */
  pendingInterestMintStroops: bigint;
  /**
   * Hardening A2: stroops on `kind='interest_mint'` rows in state
   * `failed`. Still counted into the circulation side (the mirror
   * credit genuinely exists) but tracked as the failed-rows alert
   * dimension — the mirror stays ahead of chain until an operator
   * retries the mint.
   */
  failedInterestMintStroops: bigint;
  thresholdStroops: bigint;
  over: boolean;
  previousState: DriftState;
  nextState: DriftState;
  /** Failed-rows dimension before/after this tick. */
  previousFailedRowsState: AssetFailedRowsState;
  nextFailedRowsState: Exclude<AssetFailedRowsState, 'unknown'>;
  /** True when this tick fired any Discord page (drift or failed-rows transition). */
  notified: boolean;
}

export interface DriftTickResult {
  /** Assets actually read (excludes Horizon failures). */
  checked: number;
  /** Assets skipped because Horizon returned an error this tick. */
  skipped: number;
  samples: AssetDriftSample[];
  /** S4-8: true when another machine held the fleet-wide watcher lock. */
  skippedLocked: boolean;
}

export interface RunDriftTickArgs {
  thresholdStroops: bigint;
}

/**
 * S4-8 (docs/readiness-backlog-2026-07-03.md): fixed advisory-lock key
 * for the asset-drift-watcher single-flight, same sha256→int64
 * derivation as `interestMintLockKey` / `ledgerInvariantLockKey`,
 * fixed scope string. Note this is orthogonal to the PAGING dedup
 * `asset-drift-state-repo.ts` already does (a per-asset DB row +
 * lease claims exactly one page per transition, fleet-wide) — that
 * mechanism only dedupes the ALERT. Without this lock every machine
 * still independently re-reads Horizon + the ledger every tick; this
 * lock dedupes the READS.
 */
function assetDriftLockKey(): bigint {
  const digest = createHash('sha256').update('loop:asset-drift-watcher').digest();
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

/** Fiat backing each LOOP code — 1:1 by design. */
function fiatOf(code: LoopAssetCode): HomeCurrency {
  switch (code) {
    case 'USDLOOP':
      return 'USD';
    case 'GBPLOOP':
      return 'GBP';
    case 'EURLOOP':
      return 'EUR';
  }
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * Single pass. For each configured LOOP asset: read Horizon
 * issuance + the forward-mint pool balance, sum the off-chain
 * ledger, compute drift, compare to threshold, persist the sample,
 * and emit transition notifications when either state dimension
 * flips.
 *
 * Reconciliation equation (ADR 009 + ADR 015 + ADR 036 + ADR 031
 * with on-chain as source of truth):
 *
 *   driftStroops = (onChain − pool − unconfirmedBurns + unconfirmedInterestMints)
 *                  − userCreditsLiability × 1e5
 *
 *   - onChain: total LOOP-asset issued from the issuer (held by
 *     anyone other than the issuer itself; Horizon `/assets`).
 *   - pool: stroops in the operator's interest forward-mint pool
 *     account. Pre-minted ahead of daily distribution; not yet
 *     allocated to a user. Subtracted because off-chain
 *     `user_credits` doesn't yet reflect this LOOP. Only meaningful
 *     under the LEGACY off-chain accrual path — the ADR 031 on-chain
 *     mint path doesn't pre-mint a pool, so the term reads zero
 *     there; it stays in the equation until the legacy path is
 *     deleted outright.
 *   - unconfirmedBurns: stroops on un-confirmed `kind='burn'` payout
 *     rows (ADR 036 redemption), pending/submitted AND failed.
 *     markOrderPaid debits the mirror and enqueues the burn in one
 *     txn, but the received LOOP stays at the deposit account (still
 *     "in circulation" from Horizon's view) until the payout worker
 *     forwards it to the issuer. Subtracting keeps a redemption
 *     drift-neutral end-to-end.
 *   - unconfirmedInterestMints: stroops on un-confirmed
 *     `kind='interest_mint'` payout rows (ADR 031 nightly interest),
 *     pending/submitted AND failed. The mirror image of the burn
 *     term: the nightly interest txn credits the mirror AND enqueues
 *     the issuer-signed mint atomically, so until the mint confirms
 *     the mirror is ahead of on-chain circulation by exactly the
 *     queued amount. ADDED to the circulation side so each state is
 *     drift-neutral.
 *   - userCreditsLiability: sum of `user_credits.balance_minor`
 *     for the matching fiat.
 *
 * The `failed` sub-buckets of both un-confirmed terms are what the
 * equation can never see (they keep it neutral by design) — they are
 * tracked as the separate failed-rows alert dimension instead.
 *
 * In equilibrium drift ≈ 0. Nightly on-chain interest moves both
 * sides by exactly the same minor-unit amount (the interest-mint
 * worker's carry math guarantees mintStroops = mintedMinor × 1e5),
 * so a fully-confirmed night leaves drift untouched.
 *
 * Pure enough to be called from tests directly — the Horizon fetch,
 * ledger query, state persistence and Discord send are all injected
 * via module mocks.
 *
 * S4-8: single-flighted fleet-wide via `withAdvisoryLock` (see the
 * exported `runAssetDriftTick` wrapper below) — with N Fly machines
 * only one runs the per-asset Horizon + ledger reads this tick,
 * instead of N redundant read passes. The per-asset PAGING dedup
 * (`asset-drift-state-repo.ts`) still applies underneath and is
 * unchanged — this lock is a pure read-efficiency layer on top.
 */
async function runAssetDriftTickLocked(args: RunDriftTickArgs): Promise<DriftTickResult> {
  const assets = configuredLoopPayableAssets();
  const poolAccount = resolveInterestPoolAccount();
  const result: DriftTickResult = { checked: 0, skipped: 0, samples: [], skippedLocked: false };
  for (const { code, issuer } of assets) {
    const fiat = fiatOf(code);
    // Captured BEFORE the reads: the staleness fence in
    // `applyDriftState` compares this against the persisted row so a
    // slow machine's sample (reads taken earlier) can never overwrite
    // a newer one with inverted state.
    const readStartedAt = new Date();
    let onChainStroops: bigint;
    try {
      const snap = await getLoopAssetCirculation(code, issuer);
      onChainStroops = snap.stroops;
    } catch (err) {
      log.warn(
        { err, assetCode: code, issuer },
        'Horizon circulation read failed — skipping drift check this tick',
      );
      result.skipped++;
      continue;
    }

    // Pool balance: stroops sitting at the operator-custody interest
    // pool account. `null` when no pool is configured or the
    // account has no trustline yet — treated as zero either way.
    let poolStroops: bigint = 0n;
    if (poolAccount !== null) {
      try {
        const balance = await getAssetBalance(poolAccount, code, issuer);
        poolStroops = balance ?? 0n;
      } catch (err) {
        log.warn(
          { err, assetCode: code, poolAccount },
          'Horizon pool-balance read failed — skipping drift check this tick',
        );
        result.skipped++;
        continue;
      }
    }

    // ADR 036: un-confirmed redemption burns — mirror already debited,
    // tokens awaiting issuer-return. DB read, same failure posture
    // as the ledger read below.
    let burns: { pendingSubmittedStroops: bigint; failedStroops: bigint };
    try {
      burns = await sumBurnStroopsByState({ assetCode: code, assetIssuer: issuer });
    } catch (err) {
      log.error({ err, assetCode: code }, 'Un-confirmed burn read failed');
      result.skipped++;
      continue;
    }

    // ADR 031: un-confirmed interest mints — mirror already credited,
    // issuer-signed mint awaiting confirmation. Same failure posture.
    let mints: { pendingSubmittedStroops: bigint; failedStroops: bigint };
    try {
      mints = await sumInterestMintStroopsByState({
        assetCode: code,
        assetIssuer: issuer,
      });
    } catch (err) {
      log.error({ err, assetCode: code }, 'Un-confirmed interest-mint read failed');
      result.skipped++;
      continue;
    }

    let ledgerMinor: bigint;
    try {
      ledgerMinor = await sumOutstandingLiability(fiat);
    } catch (err) {
      log.error({ err, assetCode: code, fiat }, 'Ledger liability read failed');
      result.skipped++;
      continue;
    }
    result.checked++;

    const burnTermStroops = burns.pendingSubmittedStroops + burns.failedStroops;
    const mintTermStroops = mints.pendingSubmittedStroops + mints.failedStroops;
    const driftStroops =
      onChainStroops -
      poolStroops -
      burnTermStroops +
      mintTermStroops -
      ledgerMinor * STROOPS_PER_MINOR;
    const over = abs(driftStroops) >= args.thresholdStroops;
    const next: Exclude<DriftState, 'unknown'> = over ? 'over' : 'ok';
    const failedRowsPresent = burns.failedStroops + mints.failedStroops > 0n;
    const nextFailedRows: Exclude<AssetFailedRowsState, 'unknown'> = failedRowsPresent
      ? 'present'
      : 'none';

    // Persist + claim any due pages under the row lock (A3). On a
    // persistence failure we cannot make a race-free paging decision,
    // so log and skip sends for this asset — the divergence stays in
    // the DB (or absent) and the next successful tick claims it.
    let prior: { state: DriftState; failedRowsState: AssetFailedRowsState };
    let duePages: DuePages = {};
    try {
      const applied = await applyDriftState({
        assetCode: code,
        state: next,
        failedRowsState: nextFailedRows,
        lastDriftStroops: driftStroops,
        lastThresholdStroops: args.thresholdStroops,
        failedBurnStroops: burns.failedStroops,
        failedInterestMintStroops: mints.failedStroops,
        lastCheckedAt: readStartedAt,
      });
      prior = applied.prior;
      duePages = applied.duePages;
    } catch (err) {
      log.error(
        { err, assetCode: code },
        'Drift-state persist failed — skipping page delivery this tick',
      );
      prior = { state: 'unknown', failedRowsState: 'unknown' };
    }

    const sample: AssetDriftSample = {
      assetCode: code,
      driftStroops,
      onChainStroops,
      poolStroops,
      pendingBurnStroops: burns.pendingSubmittedStroops,
      failedBurnStroops: burns.failedStroops,
      pendingInterestMintStroops: mints.pendingSubmittedStroops,
      failedInterestMintStroops: mints.failedStroops,
      thresholdStroops: args.thresholdStroops,
      over,
      previousState: prior.state,
      nextState: next,
      previousFailedRowsState: prior.failedRowsState,
      nextFailedRowsState: nextFailedRows,
      notified: false,
    };

    // Deliver the claimed pages. Sends are AWAITED and delivery is
    // recorded only on success — an undelivered page stays due and a
    // later tick (any machine) re-attempts it, so the fleet's primary
    // money alert is at-least-once, not fire-and-forget.
    if (duePages.drift !== undefined || duePages.failedRows !== undefined) {
      const delivered: { drift?: 'ok' | 'over'; failedRows?: 'none' | 'present' } = {};
      let anyFailed = false;

      if (duePages.drift === 'over') {
        const ok = await notifyAssetDrift({
          assetCode: code,
          driftStroops: driftStroops.toString(),
          thresholdStroops: args.thresholdStroops.toString(),
          onChainStroops: onChainStroops.toString(),
          ledgerLiabilityMinor: ledgerMinor.toString(),
        });
        if (ok) delivered.drift = 'over';
        else anyFailed = true;
      } else if (duePages.drift === 'recovered') {
        const ok = await notifyAssetDriftRecovered({
          assetCode: code,
          driftStroops: driftStroops.toString(),
          thresholdStroops: args.thresholdStroops.toString(),
        });
        if (ok) delivered.drift = 'ok';
        else anyFailed = true;
      }

      if (duePages.failedRows === 'present') {
        const ok = await notifyDriftFailedRows({
          assetCode: code,
          failedBurnStroops: burns.failedStroops.toString(),
          failedInterestMintStroops: mints.failedStroops.toString(),
        });
        if (ok) delivered.failedRows = 'present';
        else anyFailed = true;
      } else if (duePages.failedRows === 'cleared') {
        const ok = await notifyDriftFailedRowsCleared({ assetCode: code });
        if (ok) delivered.failedRows = 'none';
        else anyFailed = true;
      }

      try {
        if (delivered.drift !== undefined || delivered.failedRows !== undefined) {
          await markPagesDelivered({ assetCode: code, ...delivered });
          sample.notified = true;
        }
        if (anyFailed) {
          // Free the lease so the next tick retries immediately
          // instead of waiting out the lease window.
          await releasePageLease(code);
        }
      } catch (err) {
        // Delivery bookkeeping failed — the lease expiry re-opens the
        // claim; worst case is a duplicate page, never a lost one.
        log.error({ err, assetCode: code }, 'Drift page delivery bookkeeping failed');
      }
    }

    result.samples.push(sample);
  }
  lastTickMs = Date.now();
  return result;
}

/**
 * Hard ceiling on how long the lock holder may run one tick
 * (`db/client.ts` puts lease responsibility on the CALLER — the
 * payout worker's `PAYOUT_TICK_LEASE_MS` is the established pattern,
 * INV-9). The tick does 2-4 Horizon reads + 3 DB reads per configured
 * asset (3 assets max) plus up to 4 awaited Discord sends (5s cap
 * each) — 240s is generous headroom under the 300s default cadence.
 * On expiry the lock releases and the orphaned tick body degrades to
 * the pre-S4-8 per-machine concurrency (safe: the A3 persisted-state
 * repo already serialises transition claims via row locks + the
 * staleness fence), never a fleet stall.
 */
const ASSET_DRIFT_TICK_LEASE_MS = 240_000;

/** Distinct sentinel so the lease-timeout path is testable + loggable. */
const TICK_LEASE_TIMED_OUT = Symbol('asset-drift-tick-lease-timeout');

/**
 * S4-8: fleet-wide single-flight wrapper around
 * `runAssetDriftTickLocked`, copying the `withAdvisoryLock` +
 * zeroed-result pattern from `runInterestMintTick`
 * (`../credits/interest-mint.ts`) plus the payout worker's lease
 * deadline. With N Fly machines running the same interval, only the
 * lock holder reads Horizon + the ledger this tick; the rest return
 * immediately with `skippedLocked: true` and no I/O. `lastTickMs`
 * (surfaced by `getAssetDriftState`) only advances on a machine that
 * actually won the lock and ran the full pass — the per-asset
 * `lastCheckedMs` from the persisted `asset_drift_state` table (A3)
 * remains the fleet-wide-authoritative freshness signal.
 *
 * Public API unchanged for existing callers (`startAssetDriftWatcher`,
 * the test suite) — this is still `runAssetDriftTick`, just now
 * single-flighted.
 */
export async function runAssetDriftTick(args: RunDriftTickArgs): Promise<DriftTickResult> {
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(assetDriftLockKey(), () =>
    Promise.race([
      runAssetDriftTickLocked(args),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(() => resolve(TICK_LEASE_TIMED_OUT), ASSET_DRIFT_TICK_LEASE_MS);
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) {
    return { checked: 0, skipped: 0, samples: [], skippedLocked: true };
  }
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: ASSET_DRIFT_TICK_LEASE_MS },
      'Asset-drift tick exceeded the lease deadline — releasing the lock so the fleet is not stalled; the in-flight tick degrades to the pre-S4-8 per-machine posture',
    );
    return { checked: 0, skipped: 0, samples: [], skippedLocked: false };
  }
  return locked.value;
}

/**
 * Read-only snapshot of the watcher's persisted state. Used by the
 * admin handler so the UI can render "which assets are currently
 * drifted / carrying failed money-movement rows?" without hitting
 * Horizon from the browser.
 *
 * Per-asset rows come from Postgres (A3) so any machine serves the
 * same fleet-wide values; `lastTickMs` / `running` describe THIS
 * process's interval loop (the workers run on every machine, so the
 * machine serving the request is representative).
 *
 * Missing rows (assets the watcher has never read successfully,
 * e.g. an unconfigured issuer) return the default `state: 'unknown'`
 * snapshot.
 */
export async function getAssetDriftState(): Promise<{
  lastTickMs: number | null;
  running: boolean;
  perAsset: ReadonlyArray<DriftAssetSnapshot & { assetCode: LoopAssetCode }>;
}> {
  const assets = configuredLoopPayableAssets();
  const persisted = await listPersistedDriftStates();
  const perAsset = assets.map(({ code }) => {
    const row = persisted.get(code);
    const snapshot: DriftAssetSnapshot =
      row === undefined
        ? {
            state: 'unknown',
            lastDriftStroops: null,
            lastThresholdStroops: null,
            lastCheckedMs: null,
            failedRowsState: 'unknown',
            failedBurnStroops: null,
            failedInterestMintStroops: null,
          }
        : {
            state: row.state,
            lastDriftStroops: row.lastDriftStroops,
            lastThresholdStroops: row.lastThresholdStroops,
            lastCheckedMs: row.lastCheckedAt.getTime(),
            failedRowsState: row.failedRowsState,
            failedBurnStroops: row.failedBurnStroops,
            failedInterestMintStroops: row.failedInterestMintStroops,
          };
    return { assetCode: code, ...snapshot };
  });
  return {
    lastTickMs,
    running: driftTimer !== null,
    perAsset,
  };
}

// ─── Interval loop ────────────────────────────────────────────────────────

let driftTimer: ReturnType<typeof setInterval> | null = null;

export function startAssetDriftWatcher(args: {
  intervalMs: number;
  thresholdStroops: bigint;
}): void {
  if (driftTimer !== null) return;
  markWorkerStarted('asset_drift_watcher', {
    staleAfterMs: Math.max(args.intervalMs * 3, 60_000),
  });
  log.info(
    { intervalMs: args.intervalMs, thresholdStroops: args.thresholdStroops.toString() },
    'Starting asset drift watcher',
  );
  const tick = async (): Promise<void> => {
    try {
      const r = await runAssetDriftTick({ thresholdStroops: args.thresholdStroops });
      if (r.samples.some((s) => s.notified) || r.skipped > 0) {
        log.info(
          {
            checked: r.checked,
            skipped: r.skipped,
            transitions: r.samples.filter((s) => s.notified).map((s) => s.assetCode),
          },
          'Asset drift tick complete',
        );
      }
      // S4-8 /health honesty: a lock-skipped tick proves liveness but
      // is recorded separately from a led tick — see
      // markWorkerTickSkippedLocked's doc-comment.
      if (r.skippedLocked) {
        markWorkerTickSkippedLocked('asset_drift_watcher');
      } else {
        // NS-02 / FT-07: a tick that actually reconciled at least one
        // asset records the STANDING drift state on the money-integrity
        // gauge — markWorkerTickSuccess proves only that the tick ran,
        // not that the assets reconcile. A tick where every asset was
        // Horizon-skipped (checked === 0) or that hit the lease timeout
        // (also checked === 0) leaves the last-known value untouched.
        // The per-asset paged state is authoritative in the DB (A3);
        // this gauge is the fleet-wide "is anything drifted right now"
        // roll-up, visible independent of Discord.
        if (r.checked > 0) {
          setMoneyIntegrityBreach(
            'asset_drift',
            r.samples.some((s) => s.over),
          );
        }
        markWorkerTickSuccess('asset_drift_watcher');
      }
    } catch (err) {
      markWorkerTickFailure('asset_drift_watcher', err);
      log.error({ err }, 'Asset drift tick failed');
    }
  };
  void tick();
  driftTimer = setInterval(() => void tick(), args.intervalMs);
  driftTimer.unref();
}

export function stopAssetDriftWatcher(): void {
  if (driftTimer === null) return;
  clearInterval(driftTimer);
  driftTimer = null;
  markWorkerStopped('asset_drift_watcher');
  log.info('Asset drift watcher stopped');
}

/** Test seam — clears process-local state + stops any interval. */
export function __resetAssetDriftWatcherForTests(): void {
  if (driftTimer !== null) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
  lastTickMs = null;
}
