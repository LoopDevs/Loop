/**
 * Procurement-worker periodic-loop bootstrap (ADR 010).
 *
 * Lifted out of `apps/backend/src/orders/procurement.ts` so the
 * tick / sweep timer wiring (start / stop) lives in its own
 * focused module separate from the per-order pipeline
 * (`procureOne`) and the batch dispatcher (`runProcurementTick`)
 * in the parent file:
 *
 *   - `startProcurementWorker(args)` — kicks off the periodic
 *     `runProcurementTick` plus the sibling stuck-procurement
 *     sweep timer.
 *   - `stopProcurementWorker()` — clears both timers (graceful
 *     shutdown).
 *   - `PROCUREMENT_TIMEOUT_MS` — how stale a `procuring` row must
 *     be before the recovery sweep flips it failed (15 min).
 *   - `SWEEP_INTERVAL_MS` — how often the recovery sweep runs
 *     (60 s).
 *
 * Re-exported from `procurement.ts` so the existing import path
 * (`'../orders/procurement.js'`) used by `index.ts` and the
 * test suite keeps working unchanged.
 */
import { logger } from '../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { sweepStuckProcurement } from './transitions.js';
import { runProcurementTick } from './procurement.js';
import { PROCUREMENT_TIMEOUT_MS } from './procurement-constants.js';
import {
  runCtxSettlementStuckWatchdog,
  CTX_SETTLEMENT_STUCK_WATCHDOG_INTERVAL_MS,
} from './ctx-settlement-stuck-watchdog.js';

const log = logger.child({ area: 'procurement' });

let procurementTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let ctxSettlementWatchdogTimer: ReturnType<typeof setInterval> | null = null;

// `PROCUREMENT_TIMEOUT_MS` now lives in `./procurement-constants.js`
// (A5-6 — see that file's docstring) and is re-exported here so
// existing imports of it from this module keep resolving.
export { PROCUREMENT_TIMEOUT_MS };

/** How often the recovery sweep runs. Once a minute is generous. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export function startProcurementWorker(args: { intervalMs: number; limit?: number }): void {
  if (procurementTimer !== null) return;
  markWorkerStarted('procurement_worker', {
    staleAfterMs: Math.max(args.intervalMs * 3, 60_000),
  });
  log.info({ intervalMs: args.intervalMs }, 'Starting procurement worker');
  const tick = async (): Promise<void> => {
    try {
      const r = await runProcurementTick(args.limit !== undefined ? { limit: args.limit } : {});
      if (r.picked > 0) {
        log.info(r, 'Procurement tick complete');
      }
      markWorkerTickSuccess('procurement_worker');
    } catch (err) {
      markWorkerTickFailure('procurement_worker', err);
      log.error({ err }, 'Procurement tick failed');
    }
  };
  const sweep = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - PROCUREMENT_TIMEOUT_MS);
      const n = await sweepStuckProcurement(cutoff);
      if (n > 0) {
        log.warn({ swept: n }, 'Marked stuck procuring orders as failed');
      }
    } catch (err) {
      log.error({ err }, 'Stuck-procurement sweep failed');
    }
  };
  // NS-13: the stuck CTX-settlement watchdog runs on its own cadence,
  // single-flighted fleet-wide, sharing the procurement worker's lifecycle
  // like `stuck-payout-watchdog` shares the payout worker's and the
  // vault-emission stuck watchdog shares the emission sweep's. A settlement
  // is only ever written by `payCtxOrder` (reached from procurement), so
  // this worker is its natural home.
  const ctxSettlementWatchdogTick = async (): Promise<void> => {
    try {
      await runCtxSettlementStuckWatchdog();
    } catch (err) {
      log.error({ err }, 'Stuck CTX-settlement watchdog tick failed');
    }
  };
  void tick();
  void sweep();
  void ctxSettlementWatchdogTick();
  procurementTimer = setInterval(() => void tick(), args.intervalMs);
  procurementTimer.unref();
  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  ctxSettlementWatchdogTimer = setInterval(
    () => void ctxSettlementWatchdogTick(),
    CTX_SETTLEMENT_STUCK_WATCHDOG_INTERVAL_MS,
  );
  ctxSettlementWatchdogTimer.unref();
}

export function stopProcurementWorker(): void {
  if (procurementTimer !== null) {
    clearInterval(procurementTimer);
    procurementTimer = null;
  }
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (ctxSettlementWatchdogTimer !== null) {
    clearInterval(ctxSettlementWatchdogTimer);
    ctxSettlementWatchdogTimer = null;
  }
  markWorkerStopped('procurement_worker');
  log.info('Procurement worker stopped');
}
