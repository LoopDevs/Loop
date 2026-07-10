/**
 * Vault APY snapshot cron (ADR 031 §Detailed design D8, V5b).
 *
 * V1 shipped `recordSharePriceSnapshot` / `getLatestSharePrice` as
 * plain helpers with no scheduled caller — the "still open" gap noted
 * at the end of ADR 031 §D9 step 2. This module is that caller: on a
 * fixed cadence (`LOOP_VAULT_APY_SNAPSHOT_INTERVAL_HOURS`, default
 * 24h) it reads each active vault's LIVE share price
 * (`readVaultState`, the same Soroban read the drift watcher uses)
 * and records one row per vault into `vault_share_price_snapshots`.
 * `credits/vaults/vault-apy.ts` turns that series into the past-30-day
 * / past-90-day APY figures `GET /api/me/vault-apy` serves.
 *
 * ── Idempotency: code-dedup, not a DB constraint ────────────────────
 * `vault_share_price_snapshots` has no unique index on
 * `(asset_code, network, day)` — V1 shipped it as a plain append-only
 * history table, and adding a day-bucket unique index now would need
 * a new migration for a property this cron can enforce more simply
 * itself. Before writing, a tick reads the LATEST snapshot for the
 * vault (`getLatestSharePrice`) and compares its `takenAt`'s UTC
 * calendar day to today's: same day → skip (no insert, no update —
 * the first sample of the day wins, matching the "a re-run same-day
 * is a no-op" requirement). This is race-free ACROSS MACHINES because
 * the whole tick runs under one fleet-wide `withAdvisoryLock`
 * (mirrors `vault-drift-watcher.ts`'s single-flight discipline) — two
 * machines never both reach the read-then-write window for the same
 * vault on the same day.
 *
 * ── Why the cron reads Soroban but the APY endpoint never does ─────
 * `readVaultState` is a live RPC call (two `simulateTransaction`
 * reads per vault). This cron is the ONLY place in the vault-APY path
 * that ever calls it — `credits/vaults/vault-apy.ts` computes the
 * user-facing APY purely from the snapshot table, so a request to
 * `GET /api/me/vault-apy` never blocks on Soroban RPC latency or
 * counts against it.
 *
 * ── `sourceLedger` stays null ────────────────────────────────────────
 * V1's schema comment allows a null `sourceLedger` for "a manual/
 * backfilled snapshot". This automated cron also leaves it null: the
 * Soroban RPC wrapper this repo has today (`soroban-submit.ts`'s
 * `simulateSorobanCall`) returns only the decoded contract return
 * value, not the ledger sequence the simulation ran against —
 * threading it through would mean widening that wrapper's return
 * shape, out of scope here. `takenAt` (server clock, `defaultNow()`)
 * is the timestamp the APY math actually keys on.
 *
 * ── Scope ─────────────────────────────────────────────────────────
 * Read-only from the vault's point of view: this cron only calls
 * `readVaultState` (a Soroban simulation, not a transaction) and
 * writes to a history table nothing else reads authoritatively — no
 * value moves, no on-chain call is signed or submitted. Gated on
 * `LOOP_VAULTS_ENABLED` (checked inside the tick, mirroring every
 * other vault worker) and started only under `LOOP_WORKERS_ENABLED`
 * (see `index.ts`).
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
import { MAINNET_NETWORK_PASSPHRASE } from '../../env/schema-helpers.js';
import {
  getLatestSharePrice,
  listActiveVaults,
  recordSharePriceSnapshot,
  vaultsEnabled,
  type LoopVaultRow,
} from './registry.js';
import { readVaultState } from './vault-client.js';
import type { LoopVaultAssetCode, LoopVaultNetwork } from '../../db/schema.js';

const log = logger.child({ area: 'vault-apy-snapshot' });

/**
 * Derives the live network the same way every other vault module
 * does. Deliberately duplicated rather than imported — see
 * `vault-drift-watcher.ts`'s identical helper for why (cheap,
 * independent per module).
 */
function currentVaultNetwork(): LoopVaultNetwork {
  return env.LOOP_STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE ? 'mainnet' : 'testnet';
}

/** `YYYY-MM-DD` UTC calendar day — same shape `interest-mint.ts`'s `utcPeriodCursor` uses. */
function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function vaultApySnapshotLockKey(): bigint {
  const digest = createHash('sha256').update('loop:vault-apy-snapshot-worker').digest();
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

export interface VaultApySnapshotSample {
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  sharePricePpm: bigint;
  /** True when this tick actually inserted a new row for this vault. */
  recorded: boolean;
}

export interface VaultApySnapshotTickResult {
  checked: number;
  /** Already had a snapshot for today — no insert (idempotent no-op). */
  deduped: number;
  /** A new snapshot row was written. */
  recorded: number;
  /** A Soroban or DB read failed for this vault — logged, tick continues. */
  errored: number;
  samples: VaultApySnapshotSample[];
  skippedLocked: boolean;
}

async function snapshotOneVault(
  vault: LoopVaultRow,
  now: Date,
): Promise<{ sample: VaultApySnapshotSample | null; deduped: boolean; errored: boolean }> {
  const assetCode = vault.assetCode as LoopVaultAssetCode;
  const network = vault.network as LoopVaultNetwork;

  let sharePricePpm: bigint;
  try {
    const state = await readVaultState({ vault });
    sharePricePpm = state.sharePricePpm;
  } catch (err) {
    log.warn(
      { err, assetCode, network },
      'Soroban read failed — skipping APY snapshot for this vault this tick',
    );
    return { sample: null, deduped: false, errored: true };
  }

  let latest: Awaited<ReturnType<typeof getLatestSharePrice>>;
  try {
    latest = await getLatestSharePrice(assetCode, network);
  } catch (err) {
    log.error(
      { err, assetCode, network },
      'DB read failed while checking the day-dedup fence — skipping this tick',
    );
    return { sample: null, deduped: false, errored: true };
  }

  if (latest !== null && utcDayKey(latest.takenAt) === utcDayKey(now)) {
    return {
      sample: { assetCode, network, sharePricePpm, recorded: false },
      deduped: true,
      errored: false,
    };
  }

  try {
    await recordSharePriceSnapshot({ assetCode, network, sharePricePpm, takenAt: now });
  } catch (err) {
    log.error({ err, assetCode, network }, 'Failed to record APY snapshot — will retry next tick');
    return { sample: null, deduped: false, errored: true };
  }

  return {
    sample: { assetCode, network, sharePricePpm, recorded: true },
    deduped: false,
    errored: false,
  };
}

async function runVaultApySnapshotTickLocked(now: Date): Promise<VaultApySnapshotTickResult> {
  const result: VaultApySnapshotTickResult = {
    checked: 0,
    deduped: 0,
    recorded: 0,
    errored: 0,
    samples: [],
    skippedLocked: false,
  };
  if (!vaultsEnabled()) return result;

  const network = currentVaultNetwork();
  const vaults = await listActiveVaults(network);
  for (const vault of vaults) {
    result.checked++;
    const { sample, deduped, errored } = await snapshotOneVault(vault, now);
    if (deduped) result.deduped++;
    if (errored) result.errored++;
    if (sample !== null) {
      if (sample.recorded) result.recorded++;
      result.samples.push(sample);
    }
  }
  return result;
}

/**
 * Hard ceiling on how long the lock holder may run one tick — mirrors
 * `vault-drift-watcher.ts`'s lease pattern. At most two vaults today
 * (LOOPUSD/LOOPEUR), each needing two Soroban reads (inside
 * `readVaultState`) plus a couple of cheap DB round-trips; 60s is
 * generous headroom under the default 24h cadence. On expiry the lock
 * releases and the orphaned tick degrades to per-machine concurrency —
 * safe, since a duplicate same-day snapshot is caught by the dedup
 * check on each machine's own read, and even a lost race here only
 * ever produces at most one extra same-day row in the pathological
 * case of a read landing in the gap between two machines' dedup
 * checks (informational history, not a money path).
 */
const VAULT_APY_SNAPSHOT_TICK_LEASE_MS = 60_000;
const TICK_LEASE_TIMED_OUT = Symbol('vault-apy-snapshot-tick-lease-timeout');

export async function runVaultApySnapshotTick(args?: {
  now?: Date;
}): Promise<VaultApySnapshotTickResult> {
  const now = args?.now ?? new Date();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withAdvisoryLock(vaultApySnapshotLockKey(), () =>
    Promise.race([
      runVaultApySnapshotTickLocked(now),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(
          () => resolve(TICK_LEASE_TIMED_OUT),
          VAULT_APY_SNAPSHOT_TICK_LEASE_MS,
        );
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) {
    return {
      checked: 0,
      deduped: 0,
      recorded: 0,
      errored: 0,
      samples: [],
      skippedLocked: true,
    };
  }
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: VAULT_APY_SNAPSHOT_TICK_LEASE_MS },
      'Vault APY snapshot tick exceeded the lease deadline — releasing the lock so the fleet is not stalled',
    );
    return { checked: 0, deduped: 0, recorded: 0, errored: 0, samples: [], skippedLocked: false };
  }
  return locked.value;
}

// ─── Interval loop ────────────────────────────────────────────────────────

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

export function startVaultApySnapshotWorker(args?: { intervalMs?: number }): void {
  stopVaultApySnapshotWorker();
  const intervalMs =
    args?.intervalMs ?? env.LOOP_VAULT_APY_SNAPSHOT_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('vault_apy_snapshot', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting vault APY snapshot cron (ADR 031 §D8, V5b)');
  const tick = async (): Promise<void> => {
    try {
      const r = await runVaultApySnapshotTick();
      if (r.recorded > 0 || r.errored > 0) {
        log.info(
          { checked: r.checked, recorded: r.recorded, deduped: r.deduped, errored: r.errored },
          'Vault APY snapshot tick complete',
        );
      }
      if (r.skippedLocked) {
        markWorkerTickSkippedLocked('vault_apy_snapshot');
      } else {
        markWorkerTickSuccess('vault_apy_snapshot');
      }
    } catch (err) {
      markWorkerTickFailure('vault_apy_snapshot', err);
      log.error({ err }, 'Vault APY snapshot tick failed');
    }
  };
  void tick();
  snapshotTimer = setInterval(() => void tick(), intervalMs);
  snapshotTimer.unref();
}

export function stopVaultApySnapshotWorker(): void {
  if (snapshotTimer === null) return;
  clearInterval(snapshotTimer);
  snapshotTimer = null;
  markWorkerStopped('vault_apy_snapshot');
  log.info('Vault APY snapshot cron stopped');
}
