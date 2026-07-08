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
 *
 * S4-8 (docs/readiness-backlog-2026-07-03.md; 2026-07-09): with N Fly
 * machines, every machine ran this check independently every minute
 * — N redundant `watcher_cursors` reads, and worse, N independent
 * `cursorStaleAlertFired` booleans, so a stuck watcher paged Discord
 * up to N times per incident instead of once. Fixed by wrapping the
 * check in a transaction-scoped advisory lock
 * (`pg_try_advisory_xact_lock`, the same pattern
 * `ledger-invariant-watcher.ts` uses) so only ONE machine per tick
 * evaluates staleness and touches the one-shot gate. Transaction-
 * scoped (not `withAdvisoryLock`'s session lock) because this repo's
 * `db` client is a connection pool — a session lock's unlock could
 * land on a different pooled connection than the one that took it.
 *
 * CAVEAT — the one-shot gate can still re-fire across a lock-holder
 * ROTATION. `pg_try_advisory_xact_lock` releases at the end of each
 * call's own transaction, so lock ownership is NOT sticky between
 * ticks: tick N can be won by machine A, tick N+1 by machine B. Each
 * machine's `cursorStaleAlertFired` is process-local, so if an
 * incident spans a rotation, the new holder's local gate reads
 * `false` and can re-page once. This is a bounded, accepted
 * regression from "exactly once" to "at most once per distinct
 * lock-holder during an open incident" — still a large improvement
 * over the pre-fix "once per machine per minute" storm. A fully
 * fleet-consistent fix would persist the fired-state in Postgres (the
 * pattern `asset-drift-state-repo.ts` / `interest_pool_alert_state`
 * use for the asset-drift and interest-pool watchers) but that needs
 * a dedicated table + migration; out of scope for this pass since
 * this watchdog has no existing generic KV/alert-state home to reuse
 * without one.
 */
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
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
 * S4-8: fixed advisory-lock key for the cursor-watchdog single-flight
 * (same sha256→int64 derivation as `ledgerInvariantLockKey`, fixed
 * scope string).
 */
function cursorWatchdogLockKey(): bigint {
  const digest = createHash('sha256').update('loop:cursor-watchdog').digest();
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

export interface CursorWatchdogResult {
  /** True when another machine held the fleet-wide watchdog lock. */
  skippedLocked: boolean;
}

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
 *
 * S4-8: single-flighted fleet-wide via `pg_try_advisory_xact_lock`
 * inside a `db.transaction` (module doc-comment above has the full
 * rationale + the rotation caveat). Only the lock holder reads the
 * cursor row and manages `cursorStaleAlertFired`.
 */
let cursorStaleAlertFired = false;
export async function runCursorWatchdog(): Promise<CursorWatchdogResult> {
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${cursorWatchdogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true };
    }

    const row = await tx.query.watcherCursors.findFirst({
      where: sql`${watcherCursors.name} = ${WATCHER_NAME}`,
    });
    if (row === undefined) return { skippedLocked: false };
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
    return { skippedLocked: false };
  });
}

/** Test seam: resets the one-shot alert gate. */
export function __resetCursorWatchdogForTests(): void {
  cursorStaleAlertFired = false;
}
