/**
 * Cursor-age watchdog (A2-626) — detects a stuck payment watcher.
 *
 * Lifted out of `apps/backend/src/payments/watcher.ts`. Self-
 * contained module (constants + run function) that the periodic
 * loop in `startPaymentWatcher` calls on a 1-minute cadence.
 *
 * If the cursor hasn\'t moved in `CURSOR_STALE_MS`, fires a single
 * Discord alert (`notifyPaymentWatcherStuck`) per incident and
 * re-arms once the cursor moves again.
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
 * machines, every machine ran this check independently every minute —
 * N redundant `watcher_cursors` reads and N independent fire-once
 * booleans, so a stuck watcher paged Discord up to N times per
 * incident. The check now single-flights on a transaction-scoped
 * advisory lock (`pg_try_advisory_xact_lock`, the pattern
 * `ledger-invariant-watcher.ts` uses — transaction-scoped rather than
 * `withAdvisoryLock`'s session lock because `db` is a connection pool
 * and a session lock's unlock could land on a different pooled
 * connection than the one that took it).
 *
 * The fire-once/re-arm state is PERSISTED in `watchdog_alert_state`
 * (money-review 2026-07-09 P0 fix; ADR-038 D2 at-least-once shape,
 * same as `interest_pool_alert_state`). A per-process boolean was
 * unsafe under single-flighting in BOTH directions: a lock-holder
 * rotation mid-incident could re-page (over-paging), and — worse — a
 * machine whose boolean latched `true` during a past incident could
 * win the lock during a future, distinct incident and silently skip
 * paging (zero pages for a live money incident). The persisted
 * contract is: **at-least-once per incident, fleet-wide,
 * confirmed-delivery** — `alert_active` flips `true` only after
 * `sendWebhook` confirms delivery (a failed send stays unfired and
 * the next tick, on any machine, retries), and a healthy tick resets
 * it to `false` so the next incident pages fresh.
 *
 * The Discord send is awaited INSIDE the lock-holding transaction so
 * the delivery decision is race-free; `sendWebhook` is bounded by a
 * 5s AbortSignal timeout, so the xact lock (and its connection) is
 * held ≤~5s worst case — acceptable at this 1-minute cadence.
 */
import { sql, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { watcherCursors, watchdogAlertState } from '../db/schema.js';
import { logger } from '../logger.js';
import { notifyPaymentWatcherStuck } from '../discord.js';

// Inlined verbatim from watcher.ts to avoid a circular import
// (watcher imports `runCursorWatchdog` from this module). The
// cursor row is keyed on this stable opaque name, so a future PR
// that splits the cursor I/O can move it.
const WATCHER_NAME = 'stellar-deposits';

/** `watchdog_alert_state` row key for this watchdog. */
const ALERT_STATE_NAME = 'cursor-watchdog';

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
  /** True when this tick sent (and confirmed) the stuck page. */
  notified: boolean;
}

/**
 * Upserts the persisted fired-state. Runs under the advisory lock,
 * so no row-level locking is needed — the advisory lock serialises
 * every reader/writer of this row fleet-wide.
 */
async function persistAlertActive(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  active: boolean,
): Promise<void> {
  await tx
    .insert(watchdogAlertState)
    .values({ watchdogName: ALERT_STATE_NAME, alertActive: active })
    .onConflictDoUpdate({
      target: watchdogAlertState.watchdogName,
      set: { alertActive: active, updatedAt: sql`NOW()` },
    });
}

/**
 * A2-626 + S4-8: checks the watcher cursor's `updated_at` against the
 * staleness threshold and fires a Discord alert if exceeded, once per
 * incident fleet-wide (persisted `watchdog_alert_state` gate,
 * confirmed-delivery — see the module doc-comment). Re-runs on a
 * fixed interval from `startPaymentWatcher`; only the machine holding
 * the fleet-wide advisory lock evaluates and pages.
 *
 * Safe on a cold deploy: if no cursor row exists yet, we skip
 * silently. The watchdog is about detecting REGRESSIONS in an
 * already-running watcher, not first-boot.
 */
export async function runCursorWatchdog(): Promise<CursorWatchdogResult> {
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${cursorWatchdogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false };
    }

    const row = await tx.query.watcherCursors.findFirst({
      where: sql`${watcherCursors.name} = ${WATCHER_NAME}`,
    });
    if (row === undefined) return { skippedLocked: false, notified: false };

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, ALERT_STATE_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const ageMs = Date.now() - row.updatedAt.getTime();
    if (ageMs > CURSOR_STALE_MS) {
      if (alertActive) return { skippedLocked: false, notified: false };
      // Confirmed-delivery ordering: await the send (≤5s, bounded by
      // sendWebhook's AbortSignal timeout) and persist active=true
      // only on success — a failed send stays unfired so the next
      // tick retries (at-least-once).
      const delivered = await notifyPaymentWatcherStuck({
        cursorAgeMs: ageMs,
        lastCursor: row.cursor ?? '',
        lastUpdatedAtMs: row.updatedAt.getTime(),
      });
      log.error(
        { cursorAgeMs: ageMs, lastCursor: row.cursor, delivered },
        'Payment watcher cursor is stale — watcher may be stuck',
      );
      if (!delivered) return { skippedLocked: false, notified: false };
      await persistAlertActive(tx, true);
      return { skippedLocked: false, notified: true };
    }

    // Healthy — re-arm so the NEXT incident pages fresh. Only write
    // when a fired state actually exists (keeps healthy ticks
    // write-free).
    if (alertActive) await persistAlertActive(tx, false);
    return { skippedLocked: false, notified: false };
  });
}
