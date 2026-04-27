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
import { sweepStuckProcurement } from './transitions.js';
import { runProcurementTick } from './procurement.js';

const log = logger.child({ area: 'procurement' });

let procurementTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How stale a `procuring` order must be before the recovery sweep
 * marks it failed. 15 minutes is plenty — CTX procurement in the
 * happy path completes in a few seconds; anything hanging at the
 * 15-minute mark is a crashed worker or a deep upstream issue the
 * user shouldn't be left waiting on.
 */
const PROCUREMENT_TIMEOUT_MS = 15 * 60 * 1000;

/** How often the recovery sweep runs. Once a minute is generous. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export function startProcurementWorker(args: { intervalMs: number; limit?: number }): void {
  if (procurementTimer !== null) return;
  log.info({ intervalMs: args.intervalMs }, 'Starting procurement worker');
  const tick = async (): Promise<void> => {
    try {
      const r = await runProcurementTick(args.limit !== undefined ? { limit: args.limit } : {});
      if (r.picked > 0) {
        log.info(r, 'Procurement tick complete');
      }
    } catch (err) {
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
  void tick();
  void sweep();
  procurementTimer = setInterval(() => void tick(), args.intervalMs);
  procurementTimer.unref();
  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();
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
  log.info('Procurement worker stopped');
}
