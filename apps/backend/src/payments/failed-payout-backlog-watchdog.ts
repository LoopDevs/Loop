/**
 * Failed-payout backlog watchdog (NS-12).
 *
 * A `pending_payouts` row that terminally FAILS is paged exactly once,
 * inline, at the moment it fails (`payout-worker-pay-one.ts`
 * → `notifyPayoutFailed`). There was NO standing detector for the
 * resulting BACKLOG: if that one-shot page is lost (Discord outage, a
 * SIGTERM between the DB commit and the send, the webhook briefly
 * misconfigured) the failed row — an owed cashback / interest mint whose
 * on-chain leg never landed, or an emission that couldn't be
 * auto-compensated — becomes invisible forever. The stuck-payout
 * watchdog deliberately EXCLUDES failed rows ("they're terminal, not
 * stuck" — `admin/stuck-payouts.ts`), so nothing re-surfaced them.
 *
 * This is that standing detector: it counts uncompensated `state='failed'`
 * payout rows on a fixed cadence and pages the monitoring channel once
 * per incident, re-arming when the backlog clears. `compensated_at IS
 * NULL` scopes it to rows that still need operator action — an emission
 * the CF-21 auto-compensation already made whole (`compensated_at` set)
 * is NOT owed and is excluded, matching the same filter the
 * `pending_payouts_active_emission_unique` index uses.
 *
 * Fleet-safe, same shape as `stuck-payout-watchdog.ts`:
 *   - single-flights on a transaction-scoped advisory lock
 *     (`pg_try_advisory_xact_lock`) so with N Fly machines exactly one
 *     runs the count query and manages the fired-state per tick;
 *   - the fire-once / re-arm state is PERSISTED in `watchdog_alert_state`
 *     (ADR-038 D2 at-least-once shape): `alert_active` flips `true` only
 *     after `sendWebhook` confirms delivery — a failed send stays unfired
 *     so the next tick (any machine) retries — and a clean tick resets it
 *     so the next distinct backlog pages fresh.
 *
 * The Discord send is awaited INSIDE the lock-holding transaction (the
 * delivery decision is race-free); `sendWebhook` is bounded by its 5s
 * AbortSignal, so the lock is held ≤~5s worst case at this 1-minute
 * cadence — same envelope as the stuck-payout watchdog.
 */
import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { watchdogAlertState } from '../db/schema.js';
import { env } from '../env.js';
import {
  sendWebhook,
  escapeMarkdown,
  truncate,
  RED,
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
} from '../discord/shared.js';

export const FAILED_PAYOUT_BACKLOG_WATCHDOG_INTERVAL_MS = 60 * 1000;

/** `watchdog_alert_state` row key for this watchdog. */
const ALERT_STATE_NAME = 'failed-payout-backlog-watchdog';

/**
 * Fixed advisory-lock key for the single-flight (same sha256→int64
 * derivation as `stuckPayoutWatchdogLockKey`, distinct scope string).
 */
function failedPayoutBacklogLockKey(): bigint {
  const digest = createHash('sha256').update('loop:failed-payout-backlog-watchdog').digest();
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

export interface FailedPayoutBacklogSummary {
  /** Total uncompensated `state='failed'` payout rows. */
  total: number;
  /** Count per `pending_payouts.kind`, only kinds present in the backlog. */
  byKind: Record<string, number>;
  /** Age in whole minutes of the oldest failed row, or null when empty. */
  oldestAgeMinutes: number | null;
}

type BacklogTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface BacklogSqlRow extends Record<string, unknown> {
  kind: string;
  count: number;
  oldestAgeSeconds: number | null;
}

/**
 * Counts the standing failed-payout backlog, grouped by kind. Exported
 * so admin/ops surfaces (and tests) can read it without paging. Accepts
 * either the pool or a lock-holding transaction handle via the narrow
 * `execute` shape (same pattern as `computeLedgerDriftSql`), which sees
 * the two handles' otherwise-divergent query-builder generics as one
 * type.
 *
 * `state='failed' AND compensated_at IS NULL` = still owes value / still
 * needs operator action; a CF-21 auto-compensated emission
 * (`compensated_at` set) is made-whole and excluded.
 */
export async function listFailedPayoutBacklog(
  handle: Pick<typeof db, 'execute'> = db,
): Promise<FailedPayoutBacklogSummary> {
  const result = await handle.execute<BacklogSqlRow>(sql`
    SELECT
      kind,
      count(*)::int AS "count",
      EXTRACT(EPOCH FROM (NOW() - min(failed_at)))::int AS "oldestAgeSeconds"
    FROM pending_payouts
    WHERE state = 'failed' AND compensated_at IS NULL
    GROUP BY kind
  `);
  const rows = extractRows<BacklogSqlRow>(result);

  const byKind: Record<string, number> = {};
  let total = 0;
  let oldestAgeSeconds: number | null = null;
  for (const r of rows) {
    byKind[r.kind] = r.count;
    total += r.count;
    if (
      r.oldestAgeSeconds !== null &&
      (oldestAgeSeconds === null || r.oldestAgeSeconds > oldestAgeSeconds)
    ) {
      oldestAgeSeconds = r.oldestAgeSeconds;
    }
  }
  const oldestAgeMinutes = oldestAgeSeconds === null ? null : Math.floor(oldestAgeSeconds / 60);
  return { total, byKind, oldestAgeMinutes };
}

function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

/**
 * Delivery-confirming page for a standing failed-payout backlog. Returns
 * whether the webhook actually delivered so the caller latches the
 * fired-state only on real delivery (at-least-once).
 */
function notifyFailedPayoutBacklog(summary: FailedPayoutBacklogSummary): Promise<boolean> {
  const byKind = Object.entries(summary.byKind)
    .map(([kind, count]) => `${escapeMarkdown(kind)}=${count}`)
    .join(', ');
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Failed-payout backlog',
    color: RED,
    description: truncate(
      `${summary.total} uncompensated \`pending_payouts\` row(s) are in \`state='failed'\` and ` +
        `still owe value (cashback / interest / emission). Each was paged once at failure, but a ` +
        `lost page would otherwise leave them invisible — triage via /api/admin/payouts?state=failed ` +
        `or retry/compensate. This page repeats once per incident and re-arms when the backlog clears.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      {
        name: 'By kind',
        value: truncate(byKind.length > 0 ? byKind : '(none)', FIELD_VALUE_MAX),
        inline: false,
      },
      {
        name: 'Oldest (min)',
        value: summary.oldestAgeMinutes === null ? '_n/a_' : String(summary.oldestAgeMinutes),
        inline: true,
      },
    ],
  });
}

/**
 * Upserts the persisted fired-state. Runs under the advisory lock, so no
 * row-level locking is needed — the advisory lock serialises every
 * reader/writer of this row fleet-wide.
 */
async function persistAlertActive(tx: BacklogTx, active: boolean): Promise<void> {
  await tx
    .insert(watchdogAlertState)
    .values({ watchdogName: ALERT_STATE_NAME, alertActive: active })
    .onConflictDoUpdate({
      target: watchdogAlertState.watchdogName,
      set: { alertActive: active, updatedAt: sql`NOW()` },
    });
}

export interface FailedPayoutBacklogWatchdogResult {
  /** True when another machine held the fleet-wide watchdog lock. */
  skippedLocked: boolean;
  /** True when this tick sent (and confirmed) the backlog page. */
  notified: boolean;
  /** The backlog total observed this tick (0 when skipped-locked). */
  backlog: number;
}

/**
 * NS-12: single-flighted fleet-wide via `pg_try_advisory_xact_lock`
 * inside a `db.transaction` (module doc-comment has the full rationale).
 * Only the lock holder reads the backlog and manages the persisted
 * fired-state.
 */
export async function runFailedPayoutBacklogWatchdog(): Promise<FailedPayoutBacklogWatchdogResult> {
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${failedPayoutBacklogLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false, backlog: 0 };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, ALERT_STATE_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const summary = await listFailedPayoutBacklog(tx);
    if (summary.total === 0) {
      // Clean — re-arm so the NEXT backlog pages fresh. Only write when a
      // fired state actually exists (keeps clean ticks write-free).
      if (alertActive) await persistAlertActive(tx, false);
      return { skippedLocked: false, notified: false, backlog: 0 };
    }
    if (alertActive) return { skippedLocked: false, notified: false, backlog: summary.total };

    // Confirmed-delivery ordering: await the send and persist active=true
    // only on success — a failed send stays unfired so the next tick
    // retries (at-least-once).
    const delivered = await notifyFailedPayoutBacklog(summary);
    if (!delivered) return { skippedLocked: false, notified: false, backlog: summary.total };
    await persistAlertActive(tx, true);
    return { skippedLocked: false, notified: true, backlog: summary.total };
  });
}
