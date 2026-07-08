/**
 * Payment-watcher periodic-loop bootstrap (ADR 015 / 016 /
 * A2-626).
 *
 * Lifted out of `apps/backend/src/payments/watcher.ts` so the
 * three timer wirings (deposit-poll tick, expiry sweep, cursor-
 * age watchdog) live in their own focused module separate from
 * `runPaymentWatcherTick` (the per-tick poll body) and the
 * cursor read/write helpers in the parent file:
 *
 *   - `startPaymentWatcher(args)` — kicks off all three timers
 *     plus an immediate first tick + expiry-sweep so restart
 *     latency doesn't strand fresh deposits.
 *   - `stopPaymentWatcher()` — clears all three timers
 *     (graceful shutdown).
 *   - `PAYMENT_EXPIRY_MS` — 24h cutoff for `pending_payment` →
 *     `expired` (a user who drafted an order and walked away
 *     should see "expired" the next day rather than a stale row
 *     forever).
 *   - `EXPIRY_SWEEP_INTERVAL_MS` — 5min cadence for the expiry
 *     sweep (generous given the 24h horizon).
 *
 * Re-exported from `watcher.ts` so the existing import path
 * (`'../payments/watcher.js'`) used by `index.ts` and the test
 * suite keeps working unchanged.
 */
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { withAdvisoryLock } from '../db/client.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { sweepExpiredOrders } from '../orders/transitions.js';
import { runCursorWatchdog, CURSOR_WATCHDOG_INTERVAL_MS } from './cursor-watchdog.js';
import { runPaymentWatcherTick } from './watcher.js';

const log = logger.child({ area: 'payment-watcher' });

/**
 * Periodic loop wrapper around `runPaymentWatcherTick`. Swallows
 * per-tick errors so a transient Horizon blip doesn't kill the
 * interval — each tick is independent, and the next retry picks up
 * from the last persisted cursor.
 */
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let expirySweepTimer: ReturnType<typeof setInterval> | null = null;
let cursorWatchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How old a `pending_payment` order must be before the expiry sweep
 * transitions it to `expired`. 24h is conservative — on-chain
 * payments typically land in minutes, but a user who drafted an
 * order and walked away should see "expired" the next day rather
 * than a dead-looking row forever.
 */
const PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** How often the expiry sweep runs. 5 min is generous given 24h horizon. */
const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * S4-8 (docs/readiness-backlog-2026-07-03.md): fixed advisory-lock key
 * for the expiry-sweep single-flight, same sha256→int64 derivation as
 * `interestMintLockKey` / `ledgerInvariantLockKey`, fixed scope
 * string. `sweepExpiredOrders` is a single state-guarded UPDATE
 * (`WHERE state = 'pending_payment'`) — already CAS-safe against N
 * machines racing the same rows, so this lock is a pure efficiency
 * win (avoids N redundant full-table-ish scans every 5 min), not a
 * correctness fix.
 */
function orderExpirySweepLockKey(): bigint {
  const digest = createHash('sha256').update('loop:order-expiry-sweep').digest();
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

export function startPaymentWatcher(args: {
  account: string;
  usdcIssuer?: string | undefined;
  intervalMs: number;
  limit?: number;
}): void {
  if (watcherTimer !== null) return;
  markWorkerStarted('payment_watcher', { staleAfterMs: Math.max(args.intervalMs * 3, 60_000) });
  log.info({ intervalMs: args.intervalMs }, 'Starting payment watcher');
  const tick = async (): Promise<void> => {
    try {
      const r = await runPaymentWatcherTick({
        account: args.account,
        ...(args.usdcIssuer !== undefined ? { usdcIssuer: args.usdcIssuer } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (r.scanned > 0 || r.paid > 0 || r.skippedAmount > 0) {
        log.info(r, 'Payment watcher tick complete');
      }
      markWorkerTickSuccess('payment_watcher');
    } catch (err) {
      markWorkerTickFailure('payment_watcher', err);
      log.error({ err }, 'Payment watcher tick failed');
    }
  };
  const expirySweep = async (): Promise<void> => {
    try {
      // S4-8: single-flighted fleet-wide — see orderExpirySweepLockKey
      // doc-comment. A machine that doesn't win the lock this tick
      // just skips (another machine already covers the same window).
      const locked = await withAdvisoryLock(orderExpirySweepLockKey(), async () => {
        const cutoff = new Date(Date.now() - PAYMENT_EXPIRY_MS);
        return await sweepExpiredOrders(cutoff);
      });
      if (locked.ran && locked.value > 0) {
        log.info({ swept: locked.value }, 'Marked abandoned pending_payment orders as expired');
      }
    } catch (err) {
      log.error({ err }, 'Expiry sweep failed');
    }
  };
  const watchdog = async (): Promise<void> => {
    try {
      await runCursorWatchdog();
    } catch (err) {
      log.error({ err }, 'Cursor watchdog failed');
    }
  };
  // Kick off an immediate first tick so restart latency doesn't leave
  // fresh deposits unprocessed for a full interval.
  void tick();
  void expirySweep();
  watcherTimer = setInterval(() => void tick(), args.intervalMs);
  watcherTimer.unref();
  expirySweepTimer = setInterval(() => void expirySweep(), EXPIRY_SWEEP_INTERVAL_MS);
  expirySweepTimer.unref();
  // A2-626 — 1-minute cadence cursor-age probe. Fires a Discord
  // alert once per stuck period if the cursor hasn't moved in the
  // CURSOR_STALE_MS window (default 10 min). Doesn't fire on a
  // fresh deployment (no cursor row yet).
  cursorWatchdogTimer = setInterval(() => void watchdog(), CURSOR_WATCHDOG_INTERVAL_MS);
  cursorWatchdogTimer.unref();
}

export function stopPaymentWatcher(): void {
  if (cursorWatchdogTimer !== null) {
    clearInterval(cursorWatchdogTimer);
    cursorWatchdogTimer = null;
  }
  if (expirySweepTimer !== null) {
    clearInterval(expirySweepTimer);
    expirySweepTimer = null;
  }
  if (watcherTimer === null) return;
  clearInterval(watcherTimer);
  watcherTimer = null;
  markWorkerStopped('payment_watcher');
  log.info('Payment watcher stopped');
}
