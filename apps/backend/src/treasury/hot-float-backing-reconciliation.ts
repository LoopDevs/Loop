/**
 * NS-06 — hot-float USDC-BACKING reconciliation.
 *
 * `vault_hot_float.balance_minor` is the operator's canonical-asset
 * (USDC) working capital held OUTSIDE the vault, and the INV-V2 solvency
 * check in `credits/vaults/vault-drift-watcher.ts` COUNTS it as backing
 * (`redeemableBacking + hotFloat`). Nothing, until now, periodically
 * verified that this RECORDED float is actually matched by real on-chain
 * USDC the operator holds. This reconciler does: it is the USDC-BALANCE
 * twin of `treasury/hot-float-reconciliation.ts`'s vault-SHARE reconciler
 * (which checks the operator's on-chain SHARE balance vs bookkeeping).
 *
 * ── What it compares ─────────────────────────────────────────────────
 * Per network, over the active USDC-backed vaults (today: LOOPUSD only —
 * see the R3-1-scope note below), it sums the RECORDED float in USDC
 * stroops, INCLUDING the sub-minor carry so the figure is exact:
 *
 *   recordedStroops = Σ (balance_minor * 100000 + carry_stroops)
 *
 * and reads the operator/deposit account's ACTUAL on-chain USDC
 * (`getAccountBalances(...).usdcStroops`). `shortfall = recorded −
 * actual`.
 *
 * ── Why the check is ONE-DIRECTIONAL (shortfall only) ────────────────
 * The hot float is NOT held in a segregated wallet — it lives in the
 * operator/deposit account (`LOOP_STELLAR_DEPOSIT_ADDRESS`, which the
 * vault config requires to equal the operator pubkey), COMMINGLED with
 * user-deposit USDC awaiting settlement, CTX float, etc. So the operator's
 * on-chain USDC is almost always MUCH larger than the recorded float, and
 * a surplus (`actual > recorded`) is the NORMAL, expected state — never
 * drift. Only the SHORTFALL direction is a genuine signal:
 *
 *   recorded − actual > threshold  ⇒  the float is claiming solvency
 *   backing that is NOT physically present. This is exactly the direction
 *   INV-V2's own breach term guards (only "we owe MORE than backing
 *   covers" pages), applied to the float half of that backing.
 *
 * A shortfall means EITHER the float was over-credited (e.g. the
 * V4-accepted double-withdraw residual crediting proceeds twice — the
 * same residual the SHARE reconciler catches, surfacing HERE as
 * unbacked recorded USDC) OR real operator USDC was drawn down below the
 * float's claim by some other flow. Both leave the recorded float
 * unbacked and solvency overstated, so both must page.
 *
 * ── What it does NOT catch (honest scope, money-review) ──────────────
 * Because the comparison is against the WHOLE commingled account, a large
 * user-deposit pile can MASK a float over-credit: recorded can grow well
 * past its true backing and still stay under the (much larger) total
 * USDC, reading `ok`. This is a NECESSARY-not-sufficient solvency
 * condition — a floor check, not an equality check. The complementary
 * whole-account reconciliation is R3-1's job
 * (`payments/operator-float-reconciliation.ts`), and the vault-caused USDC
 * moves are already fed to R3-1 via `recordVaultOperatorMovement`. A
 * segregated hot-float custody wallet (which WOULD permit an exact
 * equality check) is a product decision, not something this observability
 * reconciler can manufacture. Flagged for money-review.
 *
 * ── R3-1 SCOPE (USDC only) ───────────────────────────────────────────
 * Only USDC-backed vaults are reconciled, mirroring R3-1 /
 * `recordVaultOperatorMovement`'s USDC-only tracking. LOOPEUR's EURC
 * backing has no on-chain-balance reader wired here; an EURC vault is
 * simply skipped (its `underlyingAssetCode !== 'USDC'`). The
 * `hot_float_backing_runs.underlying_asset_code` CHECK already permits
 * 'EURC' so extending later needs no migration — flag EURC's lack of
 * coverage in money-review, same as R3-1 does.
 *
 * ── Paging ───────────────────────────────────────────────────────────
 * Modeled on R3-1 / the SHARE reconciler's alert semantics: pages on
 * EVERY bad-state (`drift`/`error`) run, not fire-once — the daily
 * cadence makes per-tick paging an at-least-once reminder, not spam. A
 * `drift` result is RE-COMPUTED once before it is persisted or paged
 * (`checkOnce`), closing a concurrent-op read window (a replenish/slow-
 * path credit committing between the recorded read and the balance read).
 * NOTE: `getAccountBalances` caches 30s, so the recompute's chain side is
 * not fully independent — the recorded (DB) side, the likelier transient,
 * IS re-read; any residual one-tick blip self-heals on the next daily
 * tick. Runs persist to `hot_float_backing_runs` (migration 0071), the
 * audit trail.
 *
 * Alert-ONLY by design: a shortfall is SURFACED, never auto-corrected.
 * Rewriting `balance_minor` to match the chain is a policy decision for a
 * human (it could paper over a real leak) — this reconciler's job is to
 * make the discrepancy loud, not to silence it.
 */
import { createHash } from 'node:crypto';
import { db, withAdvisoryLock } from '../db/client.js';
import { env } from '../env.js';
import { MAINNET_NETWORK_PASSPHRASE } from '../env/schema-helpers.js';
import { logger } from '../logger.js';
import { setMoneyIntegrityBreach } from '../metrics.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { notifyHotFloatBackingShortfall } from '../discord.js';
import {
  hotFloatBackingRuns,
  type HotFloatBackingReconciliationState,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
} from '../db/schema.js';
import { listActiveVaults, vaultsEnabled, type LoopVaultRow } from '../credits/vaults/registry.js';
import { getAccountBalances } from '../payments/horizon-balances.js';
import { getHotFloatRow } from './hot-float.js';

const log = logger.child({ area: 'hot-float-backing-reconciliation' });

/** Same 7-decimal underlying-asset stroop convention every vault module uses. */
const STROOPS_PER_MINOR = 100_000n;

/** The only underlying this reconciler covers today (R3-1 scope — see header). */
const RECONCILED_UNDERLYING = 'USDC';

function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

function lockKey(): bigint {
  const digest = createHash('sha256').update('loop:hot-float-backing-reconciliation').digest();
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

export interface HotFloatBackingSample {
  network: LoopVaultNetwork;
  underlyingAssetCode: string;
  account: string;
  recordedFloatStroops: bigint | null;
  onchainUsdcStroops: bigint | null;
  /** `recorded − onchain`; positive = unbacked shortfall. Null on error. */
  shortfallStroops: bigint | null;
  thresholdStroops: bigint;
  state: HotFloatBackingReconciliationState;
  error: string | null;
}

/**
 * Pure drift classifier — exported for unit testing. ONE-DIRECTIONAL: a
 * surplus (recorded < onchain, negative shortfall) is the expected
 * commingled state and is `ok`; only a shortfall PAST the threshold is
 * `drift`. See the module header for why surplus is never drift.
 */
export function classifyHotFloatBacking(args: {
  shortfallStroops: bigint;
  thresholdStroops: bigint;
}): 'ok' | 'drift' {
  return args.shortfallStroops > args.thresholdStroops ? 'drift' : 'ok';
}

/**
 * ORDERING (TOCTOU): read the DB-recorded float FIRST, then the on-chain
 * USDC LAST. Both money-moving flows that GROW the float commit their
 * `balance_minor` credit AFTER the corresponding USDC has already landed
 * on-chain (`hot-float.ts` replenish: withdraw lands → then credit;
 * `vault-redemptions.ts` slow path: withdraw lands → then credit).
 * Reading recorded-first, chain-last means if we observe the freshly
 * credited recorded value we ALSO observe the already-arrived USDC — so a
 * concurrent inflow can never manufacture a phantom shortfall. (A
 * fast-path DRAW shrinks recorded before its settlement USDC leaves, i.e.
 * transient surplus — also safe.)
 */
async function computeSample(args: {
  network: LoopVaultNetwork;
  usdcVaults: LoopVaultRow[];
  account: string;
  usdcIssuer: string | null;
  thresholdStroops: bigint;
}): Promise<HotFloatBackingSample> {
  const base = {
    network: args.network,
    underlyingAssetCode: RECONCILED_UNDERLYING,
    account: args.account,
    thresholdStroops: args.thresholdStroops,
  };

  // DB-recorded float first (exact — includes the sub-minor carry).
  let recordedStroops = 0n;
  for (const vault of args.usdcVaults) {
    const row = await getHotFloatRow(vault.assetCode as LoopVaultAssetCode, args.network);
    recordedStroops += row.balanceMinor * STROOPS_PER_MINOR + row.carryStroops;
  }

  // On-chain USDC last.
  const snapshot = await getAccountBalances(args.account, args.usdcIssuer);
  const onchainUsdcStroops = snapshot.usdcStroops;
  if (onchainUsdcStroops === null) {
    // No USDC trustline on the operator account, or the issuer is
    // unconfigured/mismatched — either way we cannot verify the backing.
    // With a USDC vault active this is a real config gap worth paging,
    // not a silently-passing check (fail-closed, mirrors R3-1's
    // fail-closed balance read).
    return {
      ...base,
      recordedFloatStroops: null,
      onchainUsdcStroops: null,
      shortfallStroops: null,
      state: 'error',
      error:
        'operator on-chain USDC balance is unreadable (no USDC trustline, or LOOP_STELLAR_USDC_ISSUER unconfigured/mismatched) — cannot verify hot-float backing',
    };
  }

  const shortfallStroops = recordedStroops - onchainUsdcStroops;
  return {
    ...base,
    recordedFloatStroops: recordedStroops,
    onchainUsdcStroops,
    shortfallStroops,
    state: classifyHotFloatBacking({ shortfallStroops, thresholdStroops: args.thresholdStroops }),
    error: null,
  };
}

async function checkOnce(args: {
  network: LoopVaultNetwork;
  usdcVaults: LoopVaultRow[];
  account: string;
  usdcIssuer: string | null;
  thresholdStroops: bigint;
}): Promise<HotFloatBackingSample> {
  try {
    let sample = await computeSample(args);
    if (sample.state === 'drift') {
      // Recompute once before paging — a concurrent replenish/slow-path
      // credit committing between the recorded read and the balance read
      // clears here (mirrors R3-1 / the SHARE reconciler's single
      // recompute-before-page). See the header on the 30s balance cache.
      sample = await computeSample(args);
    }
    return sample;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      network: args.network,
      underlyingAssetCode: RECONCILED_UNDERLYING,
      account: args.account,
      recordedFloatStroops: null,
      onchainUsdcStroops: null,
      shortfallStroops: null,
      thresholdStroops: args.thresholdStroops,
      state: 'error',
      error: message.slice(0, 500),
    };
  }
}

async function persistRun(sample: HotFloatBackingSample): Promise<void> {
  await db.insert(hotFloatBackingRuns).values({
    network: sample.network,
    underlyingAssetCode: sample.underlyingAssetCode,
    account: sample.account,
    recordedFloatStroops: sample.recordedFloatStroops,
    onchainUsdcStroops: sample.onchainUsdcStroops,
    shortfallStroops: sample.shortfallStroops,
    thresholdStroops: sample.thresholdStroops,
    state: sample.state,
    error: sample.error,
  });
}

export interface HotFloatBackingTickResult {
  skippedLocked: boolean;
  /** Null when there is nothing to reconcile (vaults off, no USDC vault, or account unconfigured). */
  sample: HotFloatBackingSample | null;
}

async function runTickLocked(args: {
  thresholdStroops: bigint;
}): Promise<HotFloatBackingTickResult> {
  if (!vaultsEnabled()) return { skippedLocked: false, sample: null };
  const network = currentVaultNetwork();
  const vaults = await listActiveVaults(network);
  const usdcVaults = vaults.filter((v) => v.underlyingAssetCode === RECONCILED_UNDERLYING);
  if (usdcVaults.length === 0) return { skippedLocked: false, sample: null };

  const account = env.LOOP_STELLAR_DEPOSIT_ADDRESS;
  if (account === undefined) {
    // R3-1 itself isn't configured — nothing to reconcile the float
    // against (same posture as operator-float-reconciliation.ts's
    // unconfigured-account skip).
    log.warn(
      { network },
      'Hot-float backing reconciliation: LOOP_STELLAR_DEPOSIT_ADDRESS unconfigured — skipping',
    );
    return { skippedLocked: false, sample: null };
  }
  const usdcIssuer = env.LOOP_STELLAR_USDC_ISSUER ?? null;

  const sample = await checkOnce({
    network,
    usdcVaults,
    account,
    usdcIssuer,
    thresholdStroops: args.thresholdStroops,
  });

  try {
    await persistRun(sample);
  } catch (err) {
    log.error(
      { err, network: sample.network },
      'Failed to persist hot-float backing reconciliation run',
    );
  }

  if (sample.state === 'drift' || sample.state === 'error') {
    // At-least-once posture (see header) — best-effort, not retried
    // within this tick; the next daily tick re-pages if still bad.
    void notifyHotFloatBackingShortfall({
      network: sample.network,
      underlyingAssetCode: sample.underlyingAssetCode,
      account: sample.account,
      recordedFloatStroops: sample.recordedFloatStroops?.toString() ?? null,
      onchainUsdcStroops: sample.onchainUsdcStroops?.toString() ?? null,
      shortfallStroops: sample.shortfallStroops?.toString() ?? null,
      thresholdStroops: sample.thresholdStroops.toString(),
      state: sample.state === 'error' ? 'error' : 'drift',
      error: sample.error,
    });
  }

  return { skippedLocked: false, sample };
}

/**
 * Hard ceiling on how long the lock holder may run one tick — a Horizon
 * balance read happens inside the advisory lock, and `withAdvisoryLock`
 * pins a reserved pooled connection until `fn()` settles, so a hung
 * Horizon read would otherwise pin a connection AND the fleet-wide lock
 * indefinitely. This lease releases the lock so the fleet self-heals,
 * exactly like the SHARE reconciler's `VAULT_FLOAT_TICK_LEASE_MS` and
 * every other single-flighted watcher.
 */
const HOT_FLOAT_BACKING_TICK_LEASE_MS = 120_000;
const TICK_LEASE_TIMED_OUT = Symbol('hot-float-backing-reconciliation-tick-lease-timeout');

export async function runHotFloatBackingReconciliationTick(args?: {
  thresholdStroops?: bigint;
}): Promise<HotFloatBackingTickResult> {
  const thresholdStroops = args?.thresholdStroops ?? env.LOOP_HOT_FLOAT_BACKING_THRESHOLD_STROOPS;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(lockKey(), () =>
    Promise.race([
      runTickLocked({ thresholdStroops }),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(
          () => resolve(TICK_LEASE_TIMED_OUT),
          HOT_FLOAT_BACKING_TICK_LEASE_MS,
        );
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) return { skippedLocked: true, sample: null };
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: HOT_FLOAT_BACKING_TICK_LEASE_MS },
      'Hot-float backing reconciliation tick exceeded the lease deadline — releasing the lock so the fleet is not stalled',
    );
    return { skippedLocked: false, sample: null };
  }
  return locked.value;
}

// ─── Interval loop ────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startHotFloatBackingReconciliationWatcher(args?: { intervalMs?: number }): void {
  stopHotFloatBackingReconciliationWatcher();
  const intervalMs =
    args?.intervalMs ?? env.LOOP_HOT_FLOAT_BACKING_RECONCILIATION_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('hot_float_backing_reconciliation', {
    staleAfterMs: Math.max(intervalMs * 3, 60_000),
  });
  log.info({ intervalMs }, 'Starting hot-float USDC-backing reconciliation watcher (NS-06)');
  const tick = async (): Promise<void> => {
    try {
      // A lost advisory lock is a HEALTHY tick — another machine owns the
      // sweep this round (mirrors the other reconcilers).
      const r = await runHotFloatBackingReconciliationTick();
      // NS-02 / FT-07: a tick that actually reconciled records the
      // STANDING shortfall state on the money-integrity gauge —
      // markWorkerTickSuccess proves only that the tick ran. A `drift`
      // (unbacked recorded float) or `error` sample is a standing breach
      // that must stay visible on /metrics between at-least-once daily
      // pages. A lock-skip / vaults-disabled / nothing-to-reconcile tick
      // (sample === null) leaves the last-known value untouched.
      if (!r.skippedLocked && r.sample !== null) {
        setMoneyIntegrityBreach(
          'hot_float_backing',
          r.sample.state === 'drift' || r.sample.state === 'error',
        );
      }
      markWorkerTickSuccess('hot_float_backing_reconciliation');
    } catch (err) {
      markWorkerTickFailure('hot_float_backing_reconciliation', err);
      log.error({ err }, 'Hot-float backing reconciliation tick failed');
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopHotFloatBackingReconciliationWatcher(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  markWorkerStopped('hot_float_backing_reconciliation');
}
