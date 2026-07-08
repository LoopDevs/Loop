/**
 * Stuck-payout watchdog (A2-602 companion alert).
 *
 * Polls `listStuckPayoutRows` on a fixed cadence from
 * `startPayoutWorker` and pages Discord once per incident when any
 * `pending_payouts` row has sat in `pending`/`submitted` past the
 * threshold. `stuckPayoutAlertFired` is the one-shot gate: it fires
 * once when rows first appear, and resets the moment a tick finds
 * none (so the NEXT incident pages fresh).
 *
 * S4-8 (docs/readiness-backlog-2026-07-03.md; 2026-07-09): with N Fly
 * machines, every machine ran this check independently every minute
 * — N redundant `listStuckPayoutRows` reads, and N independent
 * `stuckPayoutAlertFired` booleans, so a stuck-payout incident paged
 * Discord up to N times instead of once. Fixed by wrapping the check
 * in a transaction-scoped advisory lock (`pg_try_advisory_xact_lock`,
 * the same pattern `ledger-invariant-watcher.ts` and (as of this
 * change) `cursor-watchdog.ts` use) so only ONE machine per tick
 * evaluates the stuck-row set and touches the one-shot gate.
 * Transaction-scoped rather than `withAdvisoryLock`'s session lock
 * because `db` is a connection pool — a session lock's unlock could
 * land on a different pooled connection than the one that took it.
 *
 * CAVEAT — same as `cursor-watchdog.ts`: `pg_try_advisory_xact_lock`
 * releases at the end of each call's own transaction, so the lock
 * holder is NOT sticky across ticks. An incident that spans a
 * lock-holder rotation can re-page once (the new holder's local
 * `stuckPayoutAlertFired` starts `false`) — bounded to "at most once
 * per distinct lock-holder during an open incident," a large
 * improvement over the pre-fix "once per machine per minute" storm.
 * A fully fleet-consistent fix would persist the fired-state in
 * Postgres (the pattern `asset-drift-state-repo.ts` /
 * `interest_pool_alert_state` use) but that needs a dedicated table +
 * migration; out of scope for this pass — this watchdog has no
 * existing generic KV/alert-state home to reuse without one.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifyStuckPayouts } from '../discord.js';
import { listStuckPayoutRows } from '../admin/stuck-payouts.js';

let stuckPayoutAlertFired = false;

export const STUCK_PAYOUT_WATCHDOG_INTERVAL_MS = 60 * 1000;

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
}

/**
 * S4-8: single-flighted fleet-wide via `pg_try_advisory_xact_lock`
 * inside a `db.transaction` (module doc-comment above has the full
 * rationale + the rotation caveat). Only the lock holder reads the
 * stuck-payout set and manages `stuckPayoutAlertFired`.
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
      return { skippedLocked: true };
    }

    const rows = await listStuckPayoutRows({ thresholdMinutes, limit });
    if (rows.length === 0) {
      stuckPayoutAlertFired = false;
      return { skippedLocked: false };
    }
    if (stuckPayoutAlertFired) return { skippedLocked: false };
    stuckPayoutAlertFired = true;

    const pendingCount = rows.filter((row) => row.state === 'pending').length;
    const submittedCount = rows.length - pendingCount;
    const oldest = rows.reduce((max, row) => (row.ageMinutes > max ? row.ageMinutes : max), 0);
    const firstRow = rows[0] ?? null;

    notifyStuckPayouts({
      rowCount: rows.length,
      thresholdMinutes,
      oldestAgeMinutes: oldest,
      pendingCount,
      submittedCount,
      payoutId: firstRow?.id ?? null,
      assetCode: firstRow?.assetCode ?? null,
    });
    return { skippedLocked: false };
  });
}

export function __resetStuckPayoutWatchdogForTests(): void {
  stuckPayoutAlertFired = false;
}
