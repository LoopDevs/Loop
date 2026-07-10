/**
 * Vault drift + solvency watcher (ADR 031 §Detailed design D4, V5).
 *
 * `payments/asset-drift-watcher.ts` reconciles the CLASSIC
 * USDLOOP/GBPLOOP/EURLOOP Stellar-classic assets against Horizon. It
 * knows nothing about the Soroban LOOPUSD/LOOPEUR vault share
 * tokens — so before V5, a vault desync (an unbacked share, a
 * strategy impairment, a stuck transfer) was completely SILENT. This
 * watcher closes that gap: per active vault, it checks two
 * independent invariants (`docs/invariants.md` INV-V1/INV-V2) and
 * pages Discord on breach.
 *
 * ── What "on-chain user shares" means, and why it's cheap ──────────
 * The vault share token is SEP-41 (Soroban's token standard); there
 * is no "circulating supply held by non-issuer accounts" query like
 * Horizon's classic `/assets` endpoint gives the asset-drift watcher.
 * Iterating every activated user's wallet (one Soroban simulate call
 * each, per tick) doesn't scale. Instead, this watcher uses the
 * closed-world assumption the whole vault design relies on: only the
 * OPERATOR and USER WALLETS ever hold vault shares (no third party is
 * ever transferred any). So:
 *
 *   onChainUserShares = totalSupply - operatorShareBalance
 *
 * — one `total_supply()` read (part of `readVaultState`) plus one
 * `balance(operator)` read (`getShareBalance`), independent of how
 * many users hold shares.
 *
 * ── PRE-FLIP CONFIG VALIDATION (required before LOOP_VAULTS_ENABLED=true) ──
 * These are config-correctness assumptions this watcher + the
 * `treasury/hot-float-reconciliation.ts` reconciler rely on, UNVERIFIED
 * against a real deployed vault. Confirm each during the vault config
 * review (ADR 031 §D9 step 5) before flipping the flag — same
 * validate-before-flip class as the Privy-Soroban signing DD:
 *
 *  1. **Fee-receiver share-mint (masking risk, not just a false page).**
 *     If DeFindex pays the performance fee as newly-MINTED shares to a
 *     distinct Fee-Receiver (ADR 031 §D7 / OQ8 — fee-mint mechanics are
 *     an open question), those shares are in `totalSupply` but not in
 *     `operatorShareBalance`, so they inflate `onChainUserShares`
 *     (INV-V1); and if the Fee-Receiver IS the operator, they inflate
 *     `operatorShareBalance` (the reconciler). EITHER way the inflation
 *     is POSITIVE and can OFFSET — i.e. MASK — a coincident real
 *     NEGATIVE drift/shortfall, not merely false-page. Resolution:
 *     confirm the fee is taken from managed funds pre-share-price (ADR
 *     031 §D7's stated model → no share mint, no adjustment), or if it
 *     is share-minted, identify the Fee-Receiver address and subtract
 *     its `balance` in the affected check.
 *  2. **`DISCORD_WEBHOOK_MONITORING` must be set.** An unset webhook
 *     makes `sendWebhook` return `true` (success) without sending, so a
 *     real breach is swallowed: the fire-once alert flips `alertActive`
 *     on a phantom "delivery" and never re-fires, and `/health` stays
 *     green. (A health-degrade-on-standing-breach independent of
 *     delivery is a deferred systemic follow-up shared by all watchers.)
 *  3. **Registry/account config invariants.** The underlying is a
 *     7-decimal at-par SAC (USDC/EURC); `share_asset_issuer ==
 *     vault_contract_id` (a DeFindex vault IS its own SEP-41 share
 *     token); and `LOOP_STELLAR_DEPOSIT_ADDRESS == the
 *     operator-secret pubkey` (the reconciler attributes vault USDC
 *     moves to the deposit address — `treasury/vault-operator-movement.ts`).
 *
 * ── INV-V1 — no unbacked shares ─────────────────────────────────────
 * Compares `onChainUserShares` against the off-chain-tracked net
 * (Σ `vault_emissions` shares actually transferred to users, minus Σ
 * `vault_redemptions` shares actually collected back —
 * `sumOffChainNetUserShares`, `vault-share-accounting.ts`). In
 * equilibrium these are equal by construction (every transfer/collect
 * this watcher counts is the SAME on-chain event this watcher's
 * on-chain read reflects); a persistent gap means either an
 * unaccounted share appeared on-chain (a serious integrity issue —
 * INV-V1's "no unbacked shares" is violated) or the off-chain mirror
 * thinks a transfer/collect landed that didn't (a stuck/lost tx).
 *
 * ── INV-V2 — redemption solvency ────────────────────────────────────
 * The vault path's OWN off-chain USD liability
 * (`sumVaultMirrorLiabilityMinor` — the fixed cashback we credited
 * `user_credits` for mirrored emissions, minus what we debited on
 * settled redemptions) must not exceed the vault's realizable backing:
 * `totalManaged` (the vault's live-reported redeemable underlying)
 * plus the currency's hot float (`vault_hot_float.balance_minor`,
 * operator working capital held OUTSIDE the vault — ADR 031
 * §Liquidity safeguard).
 *
 * This is deliberately NOT the tempting `onChainUserShares ×
 * sharePricePpm` vs `totalManaged` check, which is TAUTOLOGICALLY DEAD
 * (money-review V5 P0): `sharePricePpm = totalManaged / totalSupply`
 * (`readVaultState`), so `userShares × sharePrice ≤ totalManaged` for
 * any `userShares ≤ totalSupply` — the breach term can never go
 * positive, and a strategy impairment auto-depresses `sharePrice` from
 * the SAME read, self-cancelling. The mirror liability, by contrast,
 * is a fixed USD figure INDEPENDENT of the vault's self-reported
 * state, so a genuine `totalManaged` drop below it fires. See
 * `vault-share-accounting.ts`'s header for the full derivation.
 *
 * ── Failed-row alerting (asset-drift-watcher's other dimension) ────
 * `credits/vaults/vault-emissions.ts` / `vault-redemptions.ts`
 * already page Discord the moment a row goes terminally `failed`
 * (`recordStepFailure` → `notifyVaultEmissionFailed` /
 * `notifyVaultRedemptionFailed`) and run their own stuck-row
 * watchdogs. This watcher does not duplicate that — it is scoped to
 * the two STANDING invariants over the vault's current state, not
 * per-row failure detection.
 *
 * ── Paging ───────────────────────────────────────────────────────────
 * Fire-once/re-arm via `watchdog_alert_state`
 * (`vault-watchdog-alert.ts`), one row per (dimension, asset, network)
 * — simpler than `asset-drift-state-repo.ts`'s leased, staleness-
 * fenced per-asset table because this watcher's whole tick already
 * runs under ONE fleet-wide `withAdvisoryLock`, so there is no
 * multi-machine race to defend against beyond what that lock already
 * provides (see `vault-watchdog-alert.ts`'s header). A Horizon/Soroban
 * read failure for one vault is logged + skipped, never flips state —
 * a transient RPC blip must not page a spurious recovery or breach.
 */
import { createHash } from 'node:crypto';
import { withAdvisoryLock } from '../../db/client.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSkippedLocked,
  markWorkerTickSuccess,
} from '../../runtime-health.js';
import {
  notifyVaultShareDrift,
  notifyVaultShareDriftRecovered,
  notifyVaultSolvencyBreach,
  notifyVaultSolvencyRecovered,
} from '../../discord.js';
import { getHotFloatRow } from '../../treasury/hot-float.js';
import { MAINNET_NETWORK_PASSPHRASE } from '../../env/schema-helpers.js';
import { listActiveVaults, vaultsEnabled, type LoopVaultRow } from './registry.js';
import { readVaultState, getShareBalance, resolveOperatorPublicKey } from './vault-client.js';
import {
  sumOffChainNetUserShares,
  sumVaultMirrorLiabilityMinor,
} from './vault-share-accounting.js';
import { applyBinaryWatchdogAlert } from './vault-watchdog-alert.js';
import type { LoopVaultAssetCode, LoopVaultNetwork } from '../../db/schema.js';

/**
 * Derives the live network from the SAME config the vault modules
 * resolve their Stellar network from. Duplicated (not imported) from
 * `credits/vaults/vault-emissions.ts`'s identical helper deliberately
 * — importing it here would create a cross-dependency risk once
 * `vault-emissions.ts` itself needs to import from
 * `treasury/hot-float-reconciliation.ts` (which lives beside this
 * watcher and shares its network-resolution need); this one-liner is
 * cheap enough to keep independent per module.
 */
function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

const log = logger.child({ area: 'vault-drift-watcher' });

/** Same 7-decimal LOOP-asset/underlying-asset stroop convention every vault module uses. */
const STROOPS_PER_MINOR = 100_000n;

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function vaultDriftLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-drift-watcher').digest();
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

function sharesWatchdogName(assetCode: string, network: string): string {
  return `vault-drift-shares:${assetCode}:${network}`;
}
function solvencyWatchdogName(assetCode: string, network: string): string {
  return `vault-drift-solvency:${assetCode}:${network}`;
}

export interface VaultDriftSample {
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  onChainUserShares: bigint;
  offChainTrackedShares: bigint;
  sharesDrift: bigint;
  sharesThreshold: bigint;
  sharesOver: boolean;
  mirrorLiabilityStroops: bigint;
  redeemableBackingStroops: bigint;
  hotFloatStroops: bigint;
  solvencyBreachStroops: bigint;
  solvencyThresholdStroops: bigint;
  solvencyOver: boolean;
  /** True when either dimension fired a confirmed-delivered page this tick (open or close). */
  notified: boolean;
}

export interface VaultDriftTickResult {
  checked: number;
  skipped: number;
  samples: VaultDriftSample[];
  skippedLocked: boolean;
}

export interface RunVaultDriftTickArgs {
  sharesThreshold: bigint;
  solvencyThresholdStroops: bigint;
}

async function checkOneVault(
  vault: LoopVaultRow,
  args: RunVaultDriftTickArgs,
): Promise<VaultDriftSample | null> {
  const assetCode = vault.assetCode as LoopVaultAssetCode;
  const network = vault.network as LoopVaultNetwork;

  let state: Awaited<ReturnType<typeof readVaultState>>;
  let operatorShareBalance: bigint;
  try {
    state = await readVaultState({ vault });
    operatorShareBalance = await getShareBalance({
      vault,
      address: resolveOperatorPublicKey(),
    });
  } catch (err) {
    log.warn(
      { err, assetCode, network },
      'Soroban read failed — skipping vault drift check this tick',
    );
    return null;
  }

  let onChainUserShares = state.totalSupply - operatorShareBalance;
  if (onChainUserShares < 0n) {
    // Should not happen (an on-chain balance can't exceed supply), but
    // a cross-call read skew (two separate RPC round-trips at
    // different ledgers) could transiently produce this. Clamp + warn
    // rather than let a negative "user shares" figure propagate into
    // the solvency value calc below.
    log.warn(
      {
        assetCode,
        network,
        totalSupply: state.totalSupply.toString(),
        operatorShareBalance: operatorShareBalance.toString(),
      },
      'operatorShareBalance exceeds totalSupply — clamping onChainUserShares to 0 (likely a cross-read skew)',
    );
    onChainUserShares = 0n;
  }

  let offChainTrackedShares: bigint;
  let hotFloatBalanceMinor: bigint;
  let vaultMirrorLiabilityMinor: bigint;
  try {
    offChainTrackedShares = await sumOffChainNetUserShares(assetCode, network);
    hotFloatBalanceMinor = (await getHotFloatRow(assetCode, network)).balanceMinor;
    vaultMirrorLiabilityMinor = await sumVaultMirrorLiabilityMinor(assetCode, network);
  } catch (err) {
    log.error({ err, assetCode, network }, 'DB read failed — skipping vault drift check this tick');
    return null;
  }

  const sharesDrift = onChainUserShares - offChainTrackedShares;
  const sharesOver = abs(sharesDrift) >= args.sharesThreshold;

  // INV-V2 solvency: the vault path's own fixed USD liability vs its
  // realizable backing. Mirror liability is INDEPENDENT of the vault's
  // self-reported price/managed (unlike `onChainUserShares ×
  // sharePrice`, which is tautologically ≤ totalManaged — money-review
  // V5 P0), so a genuine `totalManaged` drop below it actually fires.
  const mirrorLiabilityStroops = vaultMirrorLiabilityMinor * STROOPS_PER_MINOR;
  const redeemableBackingStroops = state.totalManaged;
  const hotFloatStroops = hotFloatBalanceMinor * STROOPS_PER_MINOR;
  // Only the positive direction (we owe MORE than backing covers) is a
  // solvency risk; backing exceeding liability is conservative, not
  // page-worthy.
  const solvencyBreachStroops =
    mirrorLiabilityStroops - (redeemableBackingStroops + hotFloatStroops);
  const solvencyOver = solvencyBreachStroops >= args.solvencyThresholdStroops;

  let notified = false;
  const sharesPaged = await applyBinaryWatchdogAlert({
    watchdogName: sharesWatchdogName(assetCode, network),
    shouldBeActive: sharesOver,
    notifyActive: () =>
      notifyVaultShareDrift({
        assetCode,
        network,
        driftShares: sharesDrift.toString(),
        thresholdShares: args.sharesThreshold.toString(),
        onChainUserShares: onChainUserShares.toString(),
        offChainTrackedShares: offChainTrackedShares.toString(),
      }),
    notifyRecovered: () =>
      notifyVaultShareDriftRecovered({
        assetCode,
        network,
        driftShares: sharesDrift.toString(),
        thresholdShares: args.sharesThreshold.toString(),
      }),
  });
  if (sharesPaged) notified = true;

  const solvencyPaged = await applyBinaryWatchdogAlert({
    watchdogName: solvencyWatchdogName(assetCode, network),
    shouldBeActive: solvencyOver,
    notifyActive: () =>
      notifyVaultSolvencyBreach({
        assetCode,
        network,
        mirrorLiabilityStroops: mirrorLiabilityStroops.toString(),
        redeemableBackingStroops: redeemableBackingStroops.toString(),
        hotFloatStroops: hotFloatStroops.toString(),
        breachStroops: solvencyBreachStroops.toString(),
        thresholdStroops: args.solvencyThresholdStroops.toString(),
      }),
    notifyRecovered: () => notifyVaultSolvencyRecovered({ assetCode, network }),
  });
  if (solvencyPaged) notified = true;

  return {
    assetCode,
    network,
    onChainUserShares,
    offChainTrackedShares,
    sharesDrift,
    sharesThreshold: args.sharesThreshold,
    sharesOver,
    mirrorLiabilityStroops,
    redeemableBackingStroops,
    hotFloatStroops,
    solvencyBreachStroops,
    solvencyThresholdStroops: args.solvencyThresholdStroops,
    solvencyOver,
    notified,
  };
}

async function runVaultDriftTickLocked(args: RunVaultDriftTickArgs): Promise<VaultDriftTickResult> {
  const result: VaultDriftTickResult = {
    checked: 0,
    skipped: 0,
    samples: [],
    skippedLocked: false,
  };
  if (!vaultsEnabled()) return result;

  const network = currentVaultNetwork();
  const vaults = await listActiveVaults(network);
  for (const vault of vaults) {
    const sample = await checkOneVault(vault, args);
    if (sample === null) {
      result.skipped++;
      continue;
    }
    result.checked++;
    result.samples.push(sample);
  }
  return result;
}

/**
 * Hard ceiling on how long the lock holder may run one tick — mirrors
 * `asset-drift-watcher.ts`'s `ASSET_DRIFT_TICK_LEASE_MS`. Two Soroban
 * reads per vault (at most 2 vaults, LOOPUSD/LOOPEUR) plus up to 4
 * awaited Discord sends; 120s is generous headroom under the default
 * 300s cadence. On expiry the lock releases and the orphaned tick
 * degrades to per-machine concurrency — safe, since
 * `vault-watchdog-alert.ts`'s read-decide-send-persist sequence is
 * itself race-tolerant (worst case a duplicate page, never a lost
 * one, if two machines somehow raced past the lock).
 */
const VAULT_DRIFT_TICK_LEASE_MS = 120_000;
const TICK_LEASE_TIMED_OUT = Symbol('vault-drift-tick-lease-timeout');

export async function runVaultDriftTick(
  args: RunVaultDriftTickArgs,
): Promise<VaultDriftTickResult> {
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(vaultDriftLockKey(), () =>
    Promise.race([
      runVaultDriftTickLocked(args),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(() => resolve(TICK_LEASE_TIMED_OUT), VAULT_DRIFT_TICK_LEASE_MS);
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) {
    return { checked: 0, skipped: 0, samples: [], skippedLocked: true };
  }
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: VAULT_DRIFT_TICK_LEASE_MS },
      'Vault-drift tick exceeded the lease deadline — releasing the lock so the fleet is not stalled',
    );
    return { checked: 0, skipped: 0, samples: [], skippedLocked: false };
  }
  return locked.value;
}

// ─── Interval loop ────────────────────────────────────────────────────────

let driftTimer: ReturnType<typeof setInterval> | null = null;

export function startVaultDriftWatcher(args?: {
  intervalMs?: number;
  sharesThreshold?: bigint;
  solvencyThresholdStroops?: bigint;
}): void {
  stopVaultDriftWatcher();
  const intervalMs = args?.intervalMs ?? env.LOOP_VAULT_DRIFT_WATCHER_INTERVAL_SECONDS * 1000;
  const sharesThreshold = args?.sharesThreshold ?? env.LOOP_VAULT_DRIFT_SHARES_THRESHOLD_STROOPS;
  const solvencyThresholdStroops =
    args?.solvencyThresholdStroops ?? env.LOOP_VAULT_DRIFT_SOLVENCY_THRESHOLD_STROOPS;
  markWorkerStarted('vault_drift_watcher', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting vault drift + solvency watcher (ADR 031 §D4, V5)');
  const tick = async (): Promise<void> => {
    try {
      const r = await runVaultDriftTick({ sharesThreshold, solvencyThresholdStroops });
      if (r.samples.some((s) => s.notified) || r.skipped > 0) {
        log.info(
          {
            checked: r.checked,
            skipped: r.skipped,
            breaches: r.samples
              .filter((s) => s.sharesOver || s.solvencyOver)
              .map((s) => s.assetCode),
          },
          'Vault drift tick complete',
        );
      }
      if (r.skippedLocked) {
        markWorkerTickSkippedLocked('vault_drift_watcher');
      } else {
        markWorkerTickSuccess('vault_drift_watcher');
      }
    } catch (err) {
      markWorkerTickFailure('vault_drift_watcher', err);
      log.error({ err }, 'Vault drift tick failed');
    }
  };
  void tick();
  driftTimer = setInterval(() => void tick(), intervalMs);
  driftTimer.unref();
}

export function stopVaultDriftWatcher(): void {
  if (driftTimer === null) return;
  clearInterval(driftTimer);
  driftTimer = null;
  markWorkerStopped('vault_drift_watcher');
  log.info('Vault drift watcher stopped');
}
