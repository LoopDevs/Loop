/**
 * Interest accrual scheduler (A2-905 / ADR 009).
 *
 * `accrueOnePeriod` — the per-tick primitive — shipped in the
 * credits-ledger batch, but the loop that actually calls it never
 * did. So the interest feature was dormant: ADR 009 documents "a
 * nightly batch job computes balance_minor × daily_rate", the DB
 * carries period-cursor uniqueness from migration 0012, and the
 * primitive has thorough test coverage — but `user_credits` rows
 * never gain interest because nothing ticks.
 *
 * This module is the tick. Gated TWO ways:
 *
 *   1. `LOOP_WORKERS_ENABLED` (the same umbrella flag the payout
 *      worker + payment watcher sit behind) — off by default
 *      outside production.
 *   2. `INTEREST_APY_BASIS_POINTS > 0` — zero disables accrual even
 *      with the umbrella flag on. Matches ADR 009's "feature-flagged
 *      off until counsel confirms the framing in each target market"
 *      stance.
 *
 * Period cursor is the UTC calendar date as `YYYY-MM-DD`. Two ticks
 * inside the same UTC day are a no-op per user+currency thanks to
 * the partial unique index from migration 0012. If the process
 * restarts mid-day, the first post-restart tick fires and the index
 * swallows the duplicate — the running totals in `AccrualResult.
 * skippedAlreadyAccrued` make that visible in the log.
 */
import { accrueOnePeriod, type AccrualPeriod } from './accrue-interest.js';
import { logger } from '../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'interest-scheduler' });

/**
 * Scheduler config resolved at startup. Kept as a distinct shape
 * from `AccrualPeriod` so the caller can pass the tick interval
 * alongside the accrual params without mixing concerns — the
 * primitive doesn't care how often it's called.
 */
export interface InterestSchedulerConfig {
  period: AccrualPeriod;
  /** Milliseconds between ticks. Default 24h. */
  intervalMs: number;
}

let timer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/** UTC calendar date as `YYYY-MM-DD` — the period-cursor shape ADR 009 pins. */
function todayUtcCursor(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Fires one accrual tick. Exported for tests + for the first-tick
 * kick in `startInterestScheduler` so the scheduler doesn't wait a
 * full `intervalMs` before the first run after a deploy.
 *
 * Guarded against concurrent invocations: if a prior tick is still
 * running (long DB, big user base) a new tick bails early rather
 * than racing. The period cursor is the dedup guarantee, but the
 * primitive does one txn per user, and two schedulers hammering the
 * same rows add no throughput — just contention.
 */
export async function tickInterestAccrual(config: InterestSchedulerConfig): Promise<void> {
  if (tickInFlight) {
    log.warn('Interest accrual tick skipped — prior tick still running');
    return;
  }
  tickInFlight = true;
  const cursor = todayUtcCursor();
  try {
    const result = await accrueOnePeriod(config.period, cursor);
    log.info(
      {
        cursor,
        apyBasisPoints: config.period.apyBasisPoints,
        periodsPerYear: config.period.periodsPerYear,
        users: result.users,
        credited: result.credited,
        skippedZero: result.skippedZero,
        skippedAlreadyAccrued: result.skippedAlreadyAccrued,
        totalsMinor: Object.fromEntries(
          Object.entries(result.totalsMinor).map(([c, v]) => [c, v.toString()]),
        ),
      },
      'Interest accrual tick complete',
    );
    markWorkerTickSuccess('interest_scheduler');
  } catch (err) {
    // Uncaught throws from `accrueOnePeriod` are infrastructure-level
    // (DB unreachable, schema mismatch). Log at error but swallow —
    // the interval keeps ticking so a transient DB blip doesn't
    // permanently disable accrual.
    markWorkerTickFailure('interest_scheduler', err);
    log.error({ err, cursor }, 'Interest accrual tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Starts the periodic tick. Safe to call multiple times — a prior
 * interval is cleared before the new one arms.
 *
 * Not called on its own if `apyBasisPoints === 0` (nothing to do),
 * so the caller should skip this entry point when the feature is
 * off to avoid log noise.
 */
export function startInterestScheduler(config: InterestSchedulerConfig): void {
  stopInterestScheduler();
  if (config.period.apyBasisPoints <= 0) {
    // Defensive — the caller should have filtered; log and no-op.
    log.warn(
      { apy: config.period.apyBasisPoints },
      'startInterestScheduler: zero APY; not starting',
    );
    return;
  }
  log.info(
    {
      apyBasisPoints: config.period.apyBasisPoints,
      periodsPerYear: config.period.periodsPerYear,
      intervalMs: config.intervalMs,
    },
    'Interest accrual scheduler starting',
  );
  markWorkerStarted('interest_scheduler', {
    staleAfterMs: Math.max(config.intervalMs * 3, 60_000),
  });
  // First tick fires on the next macrotask so the serve() handshake
  // isn't blocked by a DB sweep — the batch can take a few seconds
  // on a large user base.
  setImmediate(() => {
    void tickInterestAccrual(config);
  });
  // .unref() so this interval doesn't keep the event loop alive on
  // its own — the server's `serve()` handle is the source of truth
  // for "process should still be running."
  timer = setInterval(() => {
    void tickInterestAccrual(config);
  }, config.intervalMs);
  timer.unref();
}

export function stopInterestScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  markWorkerStopped('interest_scheduler');
}
