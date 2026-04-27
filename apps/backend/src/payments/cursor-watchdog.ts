/**
 * Cursor-age watchdog (A2-626) — detects a stuck payment watcher.
 *
 * Lifted out of `apps/backend/src/payments/watcher.ts`. Self-
 * contained module pair (constants + state + run function + test
 * seam) that the periodic loop in `startPaymentWatcher` calls on
 * a 1-minute cadence.
 *
 * If the cursor hasn\'t moved in `CURSOR_STALE_MS`, fires a single
 * Discord alert (`notifyPaymentWatcherStuck`). Never re-fires for
 * the same stall: `cursorStaleAlertFired` is the one-shot gate;
 * once the cursor moves, the gate resets.
 *
 * Safe on a cold deploy — if no cursor row exists yet (fresh
 * deployment, never ticked) the watchdog skips silently. It\'s
 * about detecting REGRESSIONS in an already-running watcher, not
 * first-boot conditions.
 *
 * Imports `WATCHER_NAME` back from watcher.ts to keep the cursor-
 * lookup keyed against the same constant the rest of the watcher
 * uses; if a future PR splits the cursor I/O into its own module
 * the constant should follow.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { watcherCursors } from '../db/schema.js';
import { logger } from '../logger.js';
import { notifyPaymentWatcherStuck } from '../discord.js';

// Inlined verbatim from watcher.ts to avoid a circular import
// (watcher imports `runCursorWatchdog` from this module). The
// cursor row is keyed on this stable opaque name, so a future PR
// that splits the cursor I/O can move it.
const WATCHER_NAME = 'stellar-deposits';

const log = logger.child({ area: 'payment-watcher' });

/**
 * A2-626: cursor-age watchdog. If the payment watcher ticks cleanly,
 * every tick either reads an empty page (no cursor change needed
 * beyond an existing row's updated_at) or advances the cursor and
 * bumps updated_at. A cursor that hasn't moved for longer than this
 * threshold is a signal the watcher is stuck — the process died,
 * Horizon is unreachable beyond the circuit-breaker window, or the
 * tick is crashing in a way that swallows all exceptions.
 *
 * 10 min is well outside the normal per-tick window (10s default
 * interval) but tight enough that ops gets paged while the cause
 * is still forensically obvious.
 */
const CURSOR_STALE_MS = 10 * 60 * 1000;

/** How often the cursor-age watchdog runs. 1 min is cheap. */
export const CURSOR_WATCHDOG_INTERVAL_MS = 60 * 1000;

/**
 * A2-626: checks the watcher cursor's `updated_at` against the
 * staleness threshold and fires a Discord alert if exceeded.
 * Re-runs on a fixed interval from `startPaymentWatcher`. Never
 * re-fires for the same stall — cursorStaleAlertFired gates the
 * notification to once per process lifetime per stuck period
 * (once the cursor moves, the gate resets).
 *
 * Safe on a cold deploy: if no cursor row exists yet, we skip
 * silently. The watchdog is about detecting REGRESSIONS in an
 * already-running watcher, not first-boot.
 */
let cursorStaleAlertFired = false;
export async function runCursorWatchdog(): Promise<void> {
  const row = await db.query.watcherCursors.findFirst({
    where: sql`${watcherCursors.name} = ${WATCHER_NAME}`,
  });
  if (row === undefined) return;
  const ageMs = Date.now() - row.updatedAt.getTime();
  if (ageMs > CURSOR_STALE_MS) {
    if (!cursorStaleAlertFired) {
      cursorStaleAlertFired = true;
      notifyPaymentWatcherStuck({
        cursorAgeMs: ageMs,
        lastCursor: row.cursor ?? '',
        lastUpdatedAtMs: row.updatedAt.getTime(),
      });
      log.error(
        { cursorAgeMs: ageMs, lastCursor: row.cursor },
        'Payment watcher cursor is stale — watcher may be stuck',
      );
    }
  } else {
    cursorStaleAlertFired = false;
  }
}

/** Test seam: resets the one-shot alert gate. */
export function __resetCursorWatchdogForTests(): void {
  cursorStaleAlertFired = false;
}
