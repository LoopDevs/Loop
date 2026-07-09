/**
 * Stuck-payout watchdog (A2-602 companion alert).
 *
 * Polls `listStuckPayoutRows` on a fixed cadence from
 * `startPayoutWorker` and pages Discord once per incident when any
 * `pending_payouts` row has sat in `pending`/`submitted` past the
 * threshold, re-arming the moment a tick finds none (so the NEXT
 * incident pages fresh).
 *
 * S4-8 (docs/readiness-backlog-2026-07-03.md; 2026-07-09): with N Fly
 * machines, every machine ran this check independently every minute —
 * N redundant `listStuckPayoutRows` reads and N independent fire-once
 * booleans, so a stuck-payout incident paged Discord up to N times.
 * The check now single-flights on a transaction-scoped advisory lock
 * (`pg_try_advisory_xact_lock`, the pattern
 * `ledger-invariant-watcher.ts` and `cursor-watchdog.ts` use —
 * transaction-scoped rather than `withAdvisoryLock`'s session lock
 * because `db` is a connection pool and a session lock's unlock could
 * land on a different pooled connection than the one that took it).
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
import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { watchdogAlertState } from '../db/schema.js';
import { notifyStuckPayouts } from '../discord.js';
import { listStuckPayoutRows } from '../admin/stuck-payouts.js';

export const STUCK_PAYOUT_WATCHDOG_INTERVAL_MS = 60 * 1000;

/** `watchdog_alert_state` row key for this watchdog. */
const ALERT_STATE_NAME = 'stuck-payout-watchdog';

/**
 * S4-8: fixed advisory-lock key for the stuck-payout-watchdog
 * single-flight (same sha256→int64 derivation as
 * `ledgerInvariantLockKey`, fixed scope string).
 */
function stuckPayoutWatchdogLockKey(): bigint {
  const digest = createHash('sha256').update('loop:stuck-payout-watchdog').digest();
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

export interface StuckPayoutWatchdogResult {
  /** True when another machine held the fleet-wide watchdog lock. */
  skippedLocked: boolean;
  /** True when this tick sent (and confirmed) the stuck-payout page. */
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
 * A2-602 + S4-8: single-flighted fleet-wide via
 * `pg_try_advisory_xact_lock` inside a `db.transaction` (module
 * doc-comment above has the full rationale). Only the lock holder
 * reads the stuck-payout set and manages the persisted fired-state.
 */
export async function runStuckPayoutWatchdog(args?: {
  thresholdMinutes?: number;
  limit?: number;
}): Promise<StuckPayoutWatchdogResult> {
  const thresholdMinutes = args?.thresholdMinutes ?? 5;
  const limit = args?.limit ?? 20;
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${stuckPayoutWatchdogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, ALERT_STATE_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const rows = await listStuckPayoutRows({ thresholdMinutes, limit });
    if (rows.length === 0) {
      // Healthy — re-arm so the NEXT incident pages fresh. Only write
      // when a fired state actually exists (keeps healthy ticks
      // write-free).
      if (alertActive) await persistAlertActive(tx, false);
      return { skippedLocked: false, notified: false };
    }
    if (alertActive) return { skippedLocked: false, notified: false };

    const pendingCount = rows.filter((row) => row.state === 'pending').length;
    const submittedCount = rows.length - pendingCount;
    const oldest = rows.reduce((max, row) => (row.ageMinutes > max ? row.ageMinutes : max), 0);
    const firstRow = rows[0] ?? null;

    // Confirmed-delivery ordering: await the send (≤5s, bounded by
    // sendWebhook's AbortSignal timeout) and persist active=true only
    // on success — a failed send stays unfired so the next tick
    // retries (at-least-once).
    const delivered = await notifyStuckPayouts({
      rowCount: rows.length,
      thresholdMinutes,
      oldestAgeMinutes: oldest,
      pendingCount,
      submittedCount,
      payoutId: firstRow?.id ?? null,
      assetCode: firstRow?.assetCode ?? null,
    });
    if (!delivered) return { skippedLocked: false, notified: false };
    await persistAlertActive(tx, true);
    return { skippedLocked: false, notified: true };
  });
}
