// periodic-cleanup worker — A4-016, A4-006
import { config } from './config/index.js';
import { evictExpiredImageCache } from './images/proxy.js';
import { sweepExpiredRateLimits } from './middleware/rate-limit.js';
import { sweepStaleIdempotencyKeys } from './admin/idempotency.js';
import { purgeExpiredAdminStepUpConsumptions } from './auth/admin-step-up.js';
import { logger } from './logger.js';

const log = logger.child({ area: 'cleanup' });

// 24h: far past 5-min token TTL, leaves forensic window for spent step-ups
const STEP_UP_CONSUMPTION_RETENTION_MS = 24 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60 * 1000;

let cleanupInterval: NodeJS.Timeout | null = null;
let rateLimitSweepInterval: NodeJS.Timeout | null = null;

export function runCleanup(): void {
  evictExpiredImageCache();
  sweepExpiredRateLimits();
  void runAdminRetentionSweeps();
}

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

export function runRateLimitSweep(): void {
  sweepExpiredRateLimits();
}

export function startCleanupInterval(): void {
  if (config.env === 'test') return;
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  // A4-006: unref so process can exit if stopCleanupInterval is missed
  cleanupInterval.unref?.();

  rateLimitSweepInterval = setInterval(runRateLimitSweep, RATE_LIMIT_SWEEP_INTERVAL_MS);
  rateLimitSweepInterval.unref?.();
}

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
