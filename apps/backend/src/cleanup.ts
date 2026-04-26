/**
 * Periodic-cleanup worker. Runs once an hour in non-test
 * environments and sweeps three caches:
 *
 * - `evictExpiredImageCache` — drops decoded image blobs whose
 *   TTL has passed (`./images/proxy.js`).
 * - `sweepExpiredRateLimits` — drops per-IP rate-limit entries
 *   whose window has reset (`./middleware/rate-limit.js`).
 * - `sweepStaleIdempotencyKeys` (A2-500, ADR-017) — expires
 *   admin-write idempotency snapshots past the 24h TTL. Fire-
 *   and-forget — a sweep failure can be retried next hour; the
 *   read-time TTL gate in `lookupIdempotencyKey` keeps replay
 *   semantics correct in the meantime.
 *
 * The interval is **not** started in `NODE_ENV=test` because
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

let cleanupInterval: NodeJS.Timeout | null = null;

/** Single sweep tick. Exported for tests that want to drive it directly. */
export function runCleanup(): void {
  evictExpiredImageCache();
  sweepExpiredRateLimits();
  void sweepStaleIdempotencyKeys();
}

/**
 * Starts the hourly cleanup interval. No-op in `NODE_ENV=test`.
 * Called once from `app.ts` at module-init time.
 */
export function startCleanupInterval(): void {
  if (env.NODE_ENV === 'test') return;
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
}

/** Stops the periodic cleanup interval. Intended for graceful shutdown. */
export function stopCleanupInterval(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
