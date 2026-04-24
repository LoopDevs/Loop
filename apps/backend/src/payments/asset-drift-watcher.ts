/**
 * Asset-drift watcher (ADR 015).
 *
 * Background companion to the admin drift-detection surface
 * (`/admin/assets`, treasury, landing). Polls Horizon for each
 * configured LOOP-branded stablecoin and compares on-chain
 * circulation against the off-chain ledger liability:
 *
 *   driftStroops = onChainStroops - ledgerLiabilityMinor * 1e5
 *
 * When |drift| exceeds a per-operator threshold, pages the
 * monitoring Discord channel so ops notices before an admin happens
 * to refresh the page. Pairs with `notifyPayoutFailed` as the two
 * stablecoin-safety alerts: payout failures catch one-off submit
 * problems; drift catches accounting divergence (systemic
 * over-minting, a stuck payout queue, Horizon-side mistakes).
 *
 * State is tracked per-asset in-memory so we only notify on
 * transitions (ok → over) and recoveries (over → ok). Every tick
 * during an ongoing incident would just be noise; state lost on
 * restart is acceptable — first tick after boot re-pages if we're
 * still over-threshold.
 *
 * Horizon failure per-asset is logged + skipped; we do NOT flip
 * state on a read failure so a 30s Horizon blip doesn't page as a
 * spurious recovery. The admin UI keeps the same invariant
 * (ledger-side stays authoritative when Horizon is down).
 */
import { configuredLoopPayableAssets, type LoopAssetCode } from '../credits/payout-asset.js';
import { sumOutstandingLiability } from '../credits/liabilities.js';
import { getLoopAssetCirculation } from './horizon-circulation.js';
import { notifyAssetDrift, notifyAssetDriftRecovered } from '../discord.js';
import { logger } from '../logger.js';
import type { HomeCurrency } from '@loop/shared';

const log = logger.child({ area: 'asset-drift-watcher' });

/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

// A2-1506: the literal union is `AssetDriftState` in `@loop/shared`.
// Re-export under the `DriftState` alias so in-file code keeps
// resolving (the watcher predates the shared type).
import type { AssetDriftState } from '@loop/shared';
export type DriftState = AssetDriftState;

/**
 * Full per-asset snapshot — the transition flag (`state`) plus the
 * raw numbers from the last tick. The admin state endpoint surfaces
 * this directly so the UI can render the current drift value
 * without re-polling Horizon from the browser.
 */
export interface DriftAssetSnapshot {
  state: DriftState;
  /** Last drift in stroops. `null` until this asset has been read at least once. */
  lastDriftStroops: bigint | null;
  /** Threshold used for the last comparison (stroops). */
  lastThresholdStroops: bigint | null;
  /** Unix ms of the last successful per-asset read. */
  lastCheckedMs: number | null;
}

const assetState = new Map<LoopAssetCode, DriftAssetSnapshot>();
let lastTickMs: number | null = null;

function currentState(code: LoopAssetCode): DriftState {
  return assetState.get(code)?.state ?? 'unknown';
}

export interface AssetDriftSample {
  assetCode: LoopAssetCode;
  driftStroops: bigint;
  thresholdStroops: bigint;
  over: boolean;
  previousState: DriftState;
  nextState: DriftState;
  /** True when this tick transitioned over<->ok and a Discord page fired. */
  notified: boolean;
}

export interface DriftTickResult {
  /** Assets actually read (excludes Horizon failures). */
  checked: number;
  /** Assets skipped because Horizon returned an error this tick. */
  skipped: number;
  samples: AssetDriftSample[];
}

export interface RunDriftTickArgs {
  thresholdStroops: bigint;
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
 * Single pass. For each configured LOOP asset: read Horizon, sum
 * ledger, compute drift, compare to threshold, emit a transition
 * notification when state flips.
 *
 * Pure enough to be called from tests directly — the Horizon fetch +
 * ledger query + Discord send are all injected via module mocks.
 */
export async function runAssetDriftTick(args: RunDriftTickArgs): Promise<DriftTickResult> {
  const assets = configuredLoopPayableAssets();
  const result: DriftTickResult = { checked: 0, skipped: 0, samples: [] };
  for (const { code, issuer } of assets) {
    const fiat = fiatOf(code);
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
    let ledgerMinor: bigint;
    try {
      ledgerMinor = await sumOutstandingLiability(fiat);
    } catch (err) {
      log.error({ err, assetCode: code, fiat }, 'Ledger liability read failed');
      result.skipped++;
      continue;
    }
    result.checked++;

    const driftStroops = onChainStroops - ledgerMinor * STROOPS_PER_MINOR;
    const over = abs(driftStroops) >= args.thresholdStroops;
    const previous = currentState(code);
    const next: DriftState = over ? 'over' : 'ok';
    const sample: AssetDriftSample = {
      assetCode: code,
      driftStroops,
      thresholdStroops: args.thresholdStroops,
      over,
      previousState: previous,
      nextState: next,
      notified: false,
    };

    if (over && previous !== 'over') {
      notifyAssetDrift({
        assetCode: code,
        driftStroops: driftStroops.toString(),
        thresholdStroops: args.thresholdStroops.toString(),
        onChainStroops: onChainStroops.toString(),
        ledgerLiabilityMinor: ledgerMinor.toString(),
      });
      sample.notified = true;
    } else if (!over && previous === 'over') {
      notifyAssetDriftRecovered({
        assetCode: code,
        driftStroops: driftStroops.toString(),
        thresholdStroops: args.thresholdStroops.toString(),
      });
      sample.notified = true;
    }

    assetState.set(code, {
      state: next,
      lastDriftStroops: driftStroops,
      lastThresholdStroops: args.thresholdStroops,
      lastCheckedMs: Date.now(),
    });
    result.samples.push(sample);
  }
  lastTickMs = Date.now();
  return result;
}

/**
 * Read-only snapshot of the watcher's in-memory state. Used by the
 * admin handler so the UI can render "which assets are currently
 * drifted?" without hitting Horizon from the browser.
 *
 * Missing entries (assets the watcher has never read successfully,
 * e.g. the process just booted or an unconfigured issuer) return the
 * default `state: 'unknown'` snapshot.
 */
export function getAssetDriftState(): {
  lastTickMs: number | null;
  running: boolean;
  perAsset: ReadonlyArray<DriftAssetSnapshot & { assetCode: LoopAssetCode }>;
} {
  const assets = configuredLoopPayableAssets();
  const perAsset = assets.map(({ code }) => {
    const snapshot: DriftAssetSnapshot = assetState.get(code) ?? {
      state: 'unknown',
      lastDriftStroops: null,
      lastThresholdStroops: null,
      lastCheckedMs: null,
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
    } catch (err) {
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
  log.info('Asset drift watcher stopped');
}

/** Test seam — clears in-memory state + stops any interval. */
export function __resetAssetDriftWatcherForTests(): void {
  if (driftTimer !== null) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
  assetState.clear();
  lastTickMs = null;
}
