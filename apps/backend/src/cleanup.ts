/**
 * Periodic-cleanup worker. Runs at two cadences in non-test
 * environments:
 *
 * **Hourly tick** (`runCleanup`):
 * - `evictExpiredImageCache` — drops decoded image blobs whose
 *   TTL has passed (`./images/proxy.js`). 7-day TTL; hourly is
 *   plenty.
 * - `sweepStaleIdempotencyKeys` — drops admin-write snapshots past
 *   the `admin.auditRetentionDays` window (NS-03). Years-long by
 *   default, so almost every tick is a no-op; hourly costs nothing
 *   and means retention doesn't wait on a restart.
 * - `purgeExpiredAdminStepUpConsumptions` — drops single-use step-up
 *   markers whose token expired long ago (SEC-02-stepup). A dead
 *   token can no longer verify, so its marker can never block a live
 *   replay; the row carries `sub`, so keeping it forever would be an
 *   unbounded PII store with no retention basis.
 * **Per-minute tick** (`runRateLimitSweep`, A4-016):
 * - `sweepExpiredRateLimits` — drops per-IP per-route rate-limit
 *   entries whose 60s window has elapsed. Bucket entries are
 *   60s by design, so an hourly sweep let ~3,600 expired entries
 *   per hour accumulate in the map. A per-minute cadence aligns
 *   sweep with bucket lifetime so the map size tracks live IPs
 *   instead of trailing them by an hour.
 *
 * The intervals are **not** started in `NODE_ENV=test` because
 * vitest imports `app.ts` repeatedly across files; a leaked
 * interval keeps the runner alive and trips timer-leak warnings
 * in suites that use `vi.useFakeTimers()`. The `stopCleanupInterval`
 * helper is exported for graceful shutdown from `index.ts`.
 */
import { config } from './config/index.js';
import { evictExpiredImageCache } from './images/proxy.js';
import { sweepExpiredRateLimits } from './middleware/rate-limit.js';
import { sweepStaleIdempotencyKeys } from './admin/idempotency.js';
import { purgeExpiredAdminStepUpConsumptions } from './auth/admin-step-up.js';
import { logger } from './logger.js';

const log = logger.child({ area: 'cleanup' });

/**
 * How long a spent step-up marker outlives its token's `exp`. A day is
 * far past the 5-minute TTL, so no live replay can slip through, while
 * leaving a comfortable forensic window on "which step-up was spent".
 */
const STEP_UP_CONSUMPTION_RETENTION_MS = 24 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// A4-016: rate-limit windows are 60s; sweep at the same cadence
// so expired entries are evicted before they accumulate.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60 * 1000;

let cleanupInterval: NodeJS.Timeout | null = null;
let rateLimitSweepInterval: NodeJS.Timeout | null = null;

/** Single hourly sweep tick. Exported for tests that want to drive it directly. */
export function runCleanup(): void {
  evictExpiredImageCache();
  // sweepExpiredRateLimits is also called from the per-minute
  // tick; running it again here is a harmless no-op (idempotent
  // O(n) walk over the map, n bounded by the cap).
  sweepExpiredRateLimits();
  // The two store-backed sweeps are fire-and-forget: this tick is
  // sync (its callers drive it directly in tests), and a retention
  // sweep failing is a log line, never a reason to skip the rest.
  void runAdminRetentionSweeps();
}

/**
 * The admin-surface retention sweeps. Exported separately from
 * `runCleanup` so a test can await them instead of racing the
 * fire-and-forget call above.
 */
export async function runAdminRetentionSweeps(): Promise<void> {
  try {
    await sweepStaleIdempotencyKeys();
  } catch (err) {
    log.error({ err }, 'Admin idempotency retention sweep failed');
  }
  try {
    const deleted = await purgeExpiredAdminStepUpConsumptions({
      retentionMs: STEP_UP_CONSUMPTION_RETENTION_MS,
    });
    if (deleted > 0) log.info({ deletedCount: deleted }, 'Swept spent admin step-up markers');
  } catch (err) {
    log.error({ err }, 'Admin step-up consumption sweep failed');
  }
}

/**
 * Per-minute rate-limit sweep tick. Exported for tests.
 */
export function runRateLimitSweep(): void {
  sweepExpiredRateLimits();
}

/**
 * Starts the hourly cleanup interval + the per-minute rate-limit
 * sweep. No-op in `NODE_ENV=test`. Called once from `app.ts` at
 * module-init time.
 */
export function startCleanupInterval(): void {
  if (config.env === 'test') return;
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  // A4-006: don't pin the event loop on this timer. Match the
  // .unref() pattern the worker timers (payout-worker.ts:160,
  // index.ts:159 force-exit) already use so a process-shutdown
  // path that misses stopCleanupInterval() can still exit cleanly.
  cleanupInterval.unref?.();

  // A4-016: per-minute rate-limit-map sweep.
  rateLimitSweepInterval = setInterval(runRateLimitSweep, RATE_LIMIT_SWEEP_INTERVAL_MS);
  rateLimitSweepInterval.unref?.();
}

/** Stops both cleanup intervals. Intended for graceful shutdown. */
export function stopCleanupInterval(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (rateLimitSweepInterval !== null) {
    clearInterval(rateLimitSweepInterval);
    rateLimitSweepInterval = null;
  }
}
