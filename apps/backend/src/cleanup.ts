/**
 * Periodic-cleanup worker. Runs at two cadences in non-test
 * environments:
 *
 * **Hourly tick** (`runCleanup`):
 * - `evictExpiredImageCache` — drops decoded image blobs whose
 *   TTL has passed (`./images/proxy.js`). 7-day TTL; hourly is
 *   plenty.
 * - `sweepStaleIdempotencyKeys` (A2-500, ADR-017) — expires
 *   admin-write idempotency snapshots past the 24h TTL. Fire-
 *   and-forget — a sweep failure can be retried next hour; the
 *   read-time TTL gate in `lookupIdempotencyKey` keeps replay
 *   semantics correct in the meantime.
 *
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
import { env } from './env.js';
import { evictExpiredImageCache } from './images/proxy.js';
import { sweepExpiredRateLimits } from './middleware/rate-limit.js';
import { sweepStaleIdempotencyKeys } from './admin/idempotency.js';

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
  void sweepStaleIdempotencyKeys();
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
  if (env.NODE_ENV === 'test') return;
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
