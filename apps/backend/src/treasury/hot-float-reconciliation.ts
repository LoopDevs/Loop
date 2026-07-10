/**
 * Vault-aware hot-float reconciliation (ADR 031 §Detailed design D4,
 * V5). Two independent, money-review-flagged gaps this closes:
 *
 * ⚠ PRE-FLIP CONFIG VALIDATION (before LOOP_VAULTS_ENABLED=true): this
 * reconciler shares the validate-before-flip checklist in
 * `credits/vaults/vault-drift-watcher.ts`'s header — especially the
 * fee-receiver share-mint MASKING risk (a positive phantom in
 * `operatorShareBalance`/`expectedOperatorShares` can offset a real
 * negative shortfall) and `LOOP_STELLAR_DEPOSIT_ADDRESS == operator
 * pubkey` (this module's R3-1 movement notes attribute vault USDC
 * moves to the deposit address). Confirm both at config review.
 *
 * ── (a) Make R3-1 vault-aware (avoid FALSE drift) ───────────────────
 * `payments/operator-float-reconciliation.ts` (R3-1) reconciles the
 * operator/deposit account's XLM/USDC balance by walking Horizon's
 * `/payments` endpoint (`listAccountPayments`) and classifying each
 * entry. A LOOPUSD vault `deposit`/`withdraw` call is a Soroban
 * `InvokeHostFunction` operation, NOT a classic `payment` operation —
 * `extractOperatorMovement`'s `if (p.type !== 'payment') return null`
 * guard means these vault-caused USDC movements are STRUCTURALLY
 * INVISIBLE to R3-1's indexer, even though they very much move the
 * account's real USDC balance (`currentBalance()` reads that balance
 * live, so it DOES reflect them). Every vault deposit/withdraw would
 * therefore look like an "un-modeled" balance change and, once vaults
 * are live, R3-1 would page FALSE drift on ordinary vault activity —
 * exactly the risk the ADR 031 V4 review flagged.
 *
 * The fix does not touch R3-1's core logic at all. R3-1 already has a
 * mechanism for "a balance change with no matching indexed payment":
 * `operator_manual_movements` rows with `movement_payment_id IS NULL`
 * are summed directly into `expectedBalanceStroops` by
 * `computeUnlinkedManualDelta`, no Horizon indexing required. Normally
 * an OPERATOR fills these in via the admin endpoint; here, the vault
 * code itself calls {@link recordVaultOperatorMovement} the moment a
 * USDC-denominated vault call lands on-chain, from three call sites:
 *   - `credits/vaults/vault-emissions.ts`'s deposit step (`direction:
 *     'out'` — USDC leaves the operator into the vault)
 *   - `credits/vaults/vault-redemptions.ts`'s SLOW-path payout step
 *     (`direction: 'in'` — USDC returns from a synchronous
 *     `vault.withdraw`)
 *   - `hot-float.ts`'s `runHotFloatReplenishTick` (`direction: 'in'`
 *     — USDC returns from a batched replenish withdraw)
 * Each call is best-effort (never throws into its caller — a failure
 * to record an explanatory row degrades to "R3-1 shows drift until an
 * operator manually explains it," never a broken money flow).
 *
 * SCOPE: USDC (LOOPUSD's backing) only. R3-1's `OperatorFloatAsset`
 * enum is `'xlm' | 'usdc'` — LOOPEUR's EURC backing isn't a tracked
 * asset at all today. Adding `'eurc'` means widening CHECK
 * constraints across four hardened R3-1 tables
 * (`operator_wallet_baselines` / `operator_manual_movements` /
 * `operator_wallet_movements` / `operator_float_reconciliation_runs`)
 * — a bigger, dedicated migration this observability PR deliberately
 * does not bundle. {@link recordVaultOperatorMovement} no-ops for a
 * non-USDC-underlying vault (logged at debug) rather than attempting
 * an insert that would fail an `asset IN ('xlm','usdc')` CHECK.
 * EURC/LOOPEUR gets NO R3-1 coverage from this PR — flag this
 * explicitly in money-review.
 *
 * ── (b) A genuine float/pool desync has no reconciler ────────────────
 * `hot-float.ts`'s `runHotFloatReplenishTick` documents a known,
 * NOT-self-correcting gap (also `docs/invariants.md`'s "Known
 * residual" under Vault redemptions): two drivers can each build a
 * REAL on-chain `vault.withdraw` for the same
 * `pending_unredeemed_shares` before either commits; if both land, the
 * vault burns MORE shares than either tick's proceeds credit back to
 * the float — untracked drift, fails closed (never a double-credit,
 * but a real loss of a reconciled position). {@link
 * runVaultFloatReconciliationTick} is that reconciler: per active
 * vault, it compares the operator's ACTUAL on-chain vault-share
 * balance against what the COMPLETE set of operator-held share buckets
 * says it should currently hold (`vault-share-accounting.ts`'s header
 * enumerates all of them):
 *
 *   expectedOperatorShares
 *     = sumOperatorHeldEmissionShares          (bucket 2)
 *     + sumOperatorHeldCollectedRedemptionShares (bucket 3)
 *     + vault_hot_float.pending_unredeemed_shares (bucket 4)
 *
 *   - bucket (2): emissions `state='deposited'` OR failed-post-deposit
 *     (deposit landed, transfer never did) — minted, operator-held.
 *   - bucket (3): redemptions collected (`collect_tx_hash` set) but no
 *     payout run yet (`payout_path IS NULL`, `state IN
 *     ('collecting','failed')`) — user's shares with the operator,
 *     DISJOINT from (4) via `payout_path IS NULL`.
 *   - bucket (4): fast-path collected shares awaiting a batched
 *     withdraw (`hot-float.ts`).
 *
 * COMPLETENESS is load-bearing (money-review V5 P1): the earlier
 * version summed only `state='deposited'` + pending, omitting buckets
 * (2)-failed and (3) entirely. Those omissions make `expected` too
 * low, so `actual` reads too high — a permanent positive phantom that
 * can numerically OFFSET (and thus mask) a real negative double-
 * withdraw shortfall of similar magnitude, defeating the whole check.
 *
 * A gap here — `operatorShareBalance` reading LOWER than expected — is
 * exactly the double-withdraw signature: shares the bookkeeping thinks
 * are still held were already burned by an earlier, untracked
 * withdraw. A gap the OTHER direction (higher than expected) is also
 * paged, as a lesser-severity anomaly worth investigating (e.g. a
 * stray transfer). A momentary read-skew from a concurrent in-flight
 * op is handled by the single recompute-before-page in
 * `checkOneVaultFloat` (money-review V5 P1-2).
 *
 * ── Paging ───────────────────────────────────────────────────────────
 * Modeled on R3-1's OWN alert semantics, not the fire-once watchdog
 * pattern `vault-drift-watcher.ts` uses: this pages on EVERY bad-state
 * run (R3-1's docstring: "that is the at-least-once reminder, not an
 * oversight"), since both this check and R3-1 itself run on a slow
 * (daily-default) cadence where per-tick paging isn't spammy. To keep
 * that honest, a `drift` result is RE-COMPUTED once before it is
 * persisted or paged (`checkOneVaultFloat`), exactly as R3-1
 * re-indexes+recomputes, so an in-flight deposit/replenish caught
 * mid-commit does not produce a one-run false page. Runs persist to
 * `vault_float_reconciliation_runs` (migration 0063), the audit trail
 * for check (b); check (a) needs no new persistence — its effect
 * surfaces entirely through R3-1's own existing
 * `operator_float_reconciliation_runs`.
 */
import { createHash } from 'node:crypto';
import { db, withAdvisoryLock } from '../db/client.js';
import { env } from '../env.js';
import { MAINNET_NETWORK_PASSPHRASE } from '../env/schema-helpers.js';
import { logger } from '../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { notifyVaultFloatDesync } from '../discord.js';
import {
  vaultFloatReconciliationRuns,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
  type VaultFloatReconciliationState,
} from '../db/schema.js';
import { listActiveVaults, vaultsEnabled, type LoopVaultRow } from '../credits/vaults/registry.js';
import { getShareBalance, resolveOperatorPublicKey } from '../credits/vaults/vault-client.js';
import {
  sumOperatorHeldEmissionShares,
  sumOperatorHeldCollectedRedemptionShares,
} from '../credits/vaults/vault-share-accounting.js';
import { getHotFloatRow } from './hot-float.js';

// (a)'s write primitive, `recordVaultOperatorMovement`, lives in its
// OWN leaf module (`vault-operator-movement.ts`) rather than here —
// `hot-float.ts` needs to call it, and this file needs `getHotFloatRow`
// FROM `hot-float.ts`, so defining it here would create a
// hot-float.ts ↔ hot-float-reconciliation.ts import cycle. Re-exported
// so existing import sites that expect it here keep resolving.
export {
  recordVaultOperatorMovement,
  type RecordVaultOperatorMovementArgs,
} from './vault-operator-movement.js';

const log = logger.child({ area: 'hot-float-reconciliation' });

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Duplicated one-liner — see `vault-drift-watcher.ts`'s identical helper doc comment for why it's not imported from `vault-emissions.ts`. */
function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

function lockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-float-reconciliation').digest();
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

// ─── (b) float/pool desync check ────────────────────────────────────────

export interface VaultFloatReconciliationSample {
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  operatorShareBalance: bigint | null;
  expectedOperatorShares: bigint | null;
  shareDelta: bigint | null;
  thresholdShares: bigint;
  state: VaultFloatReconciliationState;
  error: string | null;
}

/**
 * ORDERING (money-review V5 P1-2, TOCTOU): read the DB bookkeeping
 * FIRST, then the on-chain balance LAST. Both money-moving flows
 * commit their explanatory DB row AFTER the on-chain call lands
 * (`vault-emissions.ts` depositStep: deposit lands → then
 * `state='deposited'`; `hot-float.ts` replenish: withdraw lands → then
 * `pending_unredeemed_shares` decremented). Reading the DB first means
 * a concurrent in-flight op that has ALREADY moved the chain but NOT
 * yet committed its DB row is captured as: DB shows the PRE-op
 * bookkeeping, chain (read after) shows the POST-op balance — a
 * transient skew. The `computePass` caller re-checks once on a `drift`
 * result before paging (like R3-1's own re-index-and-recompute), which
 * closes that window (the in-flight op's DB row has committed by the
 * recompute). Reading chain-last (not via `Promise.all`) makes the
 * skew direction deterministic rather than random.
 */
async function computeVaultFloatSample(
  vault: LoopVaultRow,
  thresholdShares: bigint,
): Promise<VaultFloatReconciliationSample> {
  const assetCode = vault.assetCode as LoopVaultAssetCode;
  const network = vault.network as LoopVaultNetwork;
  // DB bookkeeping first — the complete set of operator-held share
  // buckets (see `vault-share-accounting.ts`'s header): emission
  // deposited/failed-post-deposit (2), redemption collected-not-paid
  // (3), and the hot-float fast-path pending count (4). An INCOMPLETE
  // sum here would make `expected` too low, `actual` look too high,
  // and that phantom positive could offset — and mask — a real
  // double-withdraw shortfall (money-review V5 P1).
  const [heldEmission, heldCollected, hotFloat] = await Promise.all([
    sumOperatorHeldEmissionShares(assetCode, network),
    sumOperatorHeldCollectedRedemptionShares(assetCode, network),
    getHotFloatRow(assetCode, network),
  ]);
  const expectedOperatorShares = heldEmission + heldCollected + hotFloat.pendingUnredeemedShares;
  const operatorShareBalance = await getShareBalance({
    vault,
    address: resolveOperatorPublicKey(),
  });
  const shareDelta = operatorShareBalance - expectedOperatorShares;
  const state: VaultFloatReconciliationState = abs(shareDelta) > thresholdShares ? 'drift' : 'ok';
  return {
    assetCode,
    network,
    operatorShareBalance,
    expectedOperatorShares,
    shareDelta,
    thresholdShares,
    state,
    error: null,
  };
}

async function checkOneVaultFloat(
  vault: LoopVaultRow,
  thresholdShares: bigint,
): Promise<VaultFloatReconciliationSample> {
  const assetCode = vault.assetCode as LoopVaultAssetCode;
  const network = vault.network as LoopVaultNetwork;
  try {
    let sample = await computeVaultFloatSample(vault, thresholdShares);
    if (sample.state === 'drift') {
      // A concurrent deposit/replenish that moved the chain but hasn't
      // yet committed its bookkeeping row shows up as drift on the
      // first pass. Recompute once before we page — by now the row has
      // committed, so a genuine desync persists but a TOCTOU blip
      // clears (money-review V5 P1-2; mirrors R3-1's own single
      // recompute-before-page).
      sample = await computeVaultFloatSample(vault, thresholdShares);
    }
    return sample;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      assetCode,
      network,
      operatorShareBalance: null,
      expectedOperatorShares: null,
      shareDelta: null,
      thresholdShares,
      state: 'error',
      error: message.slice(0, 500),
    };
  }
}

async function persistRun(sample: VaultFloatReconciliationSample): Promise<void> {
  await db.insert(vaultFloatReconciliationRuns).values({
    assetCode: sample.assetCode,
    network: sample.network,
    operatorShareBalance: sample.operatorShareBalance,
    expectedOperatorShares: sample.expectedOperatorShares,
    shareDelta: sample.shareDelta,
    thresholdShares: sample.thresholdShares,
    state: sample.state,
    error: sample.error,
  });
}

export interface VaultFloatReconciliationTickResult {
  skippedLocked: boolean;
  samples: VaultFloatReconciliationSample[];
}

async function runVaultFloatReconciliationTickLocked(args: {
  thresholdShares: bigint;
}): Promise<VaultFloatReconciliationTickResult> {
  if (!vaultsEnabled()) return { skippedLocked: false, samples: [] };
  const network = currentVaultNetwork();
  const vaults = await listActiveVaults(network);
  const samples: VaultFloatReconciliationSample[] = [];
  for (const vault of vaults) {
    const sample = await checkOneVaultFloat(vault, args.thresholdShares);
    try {
      await persistRun(sample);
    } catch (err) {
      log.error(
        { err, assetCode: sample.assetCode, network: sample.network },
        'Failed to persist vault float reconciliation run',
      );
    }
    if (sample.state === 'drift' || sample.state === 'error') {
      // R3-1 posture: page on EVERY bad-state run, not fire-once (see
      // module header). Best-effort — a failed send is not retried
      // within this tick; the NEXT tick (daily default) re-pages
      // since the state is still bad.
      void notifyVaultFloatDesync({
        assetCode: sample.assetCode,
        network: sample.network,
        operatorShareBalance: sample.operatorShareBalance?.toString() ?? 'unknown',
        expectedOperatorShares: sample.expectedOperatorShares?.toString() ?? 'unknown',
        shareDelta: sample.shareDelta?.toString() ?? 'unknown',
        thresholdShares: sample.thresholdShares.toString(),
      });
    }
    samples.push(sample);
  }
  return { skippedLocked: false, samples };
}

/**
 * Hard ceiling on how long the lock holder may run one tick
 * (money-review V5 P1-1). `checkOneVaultFloat` does a Soroban RPC read
 * (`getShareBalance`) inside the advisory lock, and
 * `db/client.ts`'s `withAdvisoryLock` holds a RESERVED pooled
 * connection until `fn()` settles — so a hung/slow Soroban RPC would
 * otherwise pin one of `DATABASE_POOL_MAX` connections AND the
 * fleet-wide lock indefinitely, silently disabling the one reconciler
 * built to catch the double-withdraw residual until a restart. This
 * lease releases the lock so the fleet self-heals, exactly like
 * `vault-drift-watcher.ts`'s `VAULT_DRIFT_TICK_LEASE_MS` and every
 * other single-flighted watcher (INV-4 S4-8 lease pattern). At most 2
 * vaults × (3 DB reads + 1 RPC read) + N inserts — 120s is generous
 * headroom under the 24h default cadence.
 */
const VAULT_FLOAT_TICK_LEASE_MS = 120_000;
const TICK_LEASE_TIMED_OUT = Symbol('vault-float-reconciliation-tick-lease-timeout');

export async function runVaultFloatReconciliationTick(args?: {
  thresholdShares?: bigint;
}): Promise<VaultFloatReconciliationTickResult> {
  const thresholdShares = args?.thresholdShares ?? env.LOOP_VAULT_FLOAT_SHARES_THRESHOLD_STROOPS;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(lockKey(), () =>
    Promise.race([
      runVaultFloatReconciliationTickLocked({ thresholdShares }),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(() => resolve(TICK_LEASE_TIMED_OUT), VAULT_FLOAT_TICK_LEASE_MS);
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) return { skippedLocked: true, samples: [] };
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: VAULT_FLOAT_TICK_LEASE_MS },
      'Vault float reconciliation tick exceeded the lease deadline — releasing the lock so the fleet is not stalled',
    );
    return { skippedLocked: false, samples: [] };
  }
  return locked.value;
}

// ─── Interval loop ────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startVaultFloatReconciliationWatcher(args?: { intervalMs?: number }): void {
  stopVaultFloatReconciliationWatcher();
  const intervalMs =
    args?.intervalMs ?? env.LOOP_VAULT_FLOAT_RECONCILIATION_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('vault_float_reconciliation', {
    staleAfterMs: Math.max(intervalMs * 3, 60_000),
  });
  log.info({ intervalMs }, 'Starting vault float/pool reconciliation watcher (ADR 031 §D4, V5)');
  const tick = async (): Promise<void> => {
    try {
      // A lost advisory lock is a HEALTHY tick — another machine owns
      // the sweep this round (mirrors operator-float-reconciliation.ts).
      await runVaultFloatReconciliationTick();
      markWorkerTickSuccess('vault_float_reconciliation');
    } catch (err) {
      markWorkerTickFailure('vault_float_reconciliation', err);
      log.error({ err }, 'Vault float reconciliation tick failed');
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopVaultFloatReconciliationWatcher(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  markWorkerStopped('vault_float_reconciliation');
}
