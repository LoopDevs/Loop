/**
 * Stuck CTX-settlement watchdog (NS-13).
 *
 * `payCtxOrder` forwards user-paid XLM from the operator wallet to CTX
 * (ADR 010 principal switch) and records the attempt in `ctx_settlements`:
 * one row per order, `tx_hash` persisted BEFORE the network submit, and
 * `confirmed_at` set only once an authoritative Horizon lookup shows the
 * tx landed (`orders/ctx-settlements.ts`). Every row therefore represents
 * real money-in-flight leaving Loop's custody.
 *
 * Unlike payouts, deposits, and vault emissions — each of which has a
 * stuck-watchdog — `ctx_settlements` had NO standing watcher. The
 * stuck-procurement sweep (`transitions-sweeps.ts` / `sweepStuckProcurement`)
 * only inspects orders still in `procuring`: it flips them `failed` after
 * `PROCUREMENT_TIMEOUT_MS` and consults the settlement only to decide
 * whether to refund. Once an order LEAVES `procuring` (redemption landed →
 * `fulfilled`, or a pre-payment failure → `failed`) nothing ever looks at
 * its settlement again. A settlement whose `confirmed_at` never gets set —
 * a crash after submit, a lost Horizon confirmation, the confirm step
 * simply never running — then sits unconfirmed forever, completely
 * undetected: a silent money-in / reconciliation gap (Loop's XLM left the
 * operator wallet but Loop holds no evidence CTX received it).
 *
 * This is that standing detector: it counts `confirmed_at IS NULL` rows
 * older than a staleness threshold and pages the monitoring channel once
 * per incident, re-arming when the backlog clears. A healthy settlement
 * confirms within a few Stellar ledgers (seconds), and the only writers of
 * `ctx_settlements` are `payCtxOrder` (a genuine payment attempt) and the
 * memo-scan backfill (confirmed on insert), so an old unconfirmed row is
 * always an anomaly — there are no benign long-lived unconfirmed rows to
 * false-positive on.
 *
 * Fleet-safe, same shape as `stuck-payout-watchdog.ts` /
 * `failed-payout-backlog-watchdog.ts`:
 *   - single-flights on a transaction-scoped advisory lock
 *     (`pg_try_advisory_xact_lock`) so with N Fly machines exactly one
 *     runs the query and manages the fired-state per tick;
 *   - the fire-once / re-arm state is PERSISTED in `watchdog_alert_state`
 *     (ADR-038 D2 at-least-once shape): `alert_active` flips `true` only
 *     after `sendWebhook` confirms delivery — a failed send stays unfired
 *     so the next tick (any machine) retries — and a clean tick resets it
 *     so the next distinct incident pages fresh.
 *
 * The Discord send is awaited INSIDE the lock-holding transaction (the
 * delivery decision is race-free); `sendWebhook` is bounded by its 5s
 * AbortSignal, so the lock is held ≤~5s worst case at this 1-minute
 * cadence — same envelope as the sibling watchdogs.
 *
 * Detection + paging only — this NEVER moves money. A stuck settlement may
 * mean the XLM landed and only the confirmation was lost, or that it never
 * landed at all; disambiguating is an operator/Horizon-reconciliation task,
 * not something to auto-refund or re-submit here.
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

export const CTX_SETTLEMENT_STUCK_WATCHDOG_INTERVAL_MS = 60 * 1000;

/**
 * Default staleness threshold: a settlement that has not confirmed in this
 * many minutes is stuck. 15 min matches `PROCUREMENT_TIMEOUT_MS` and the
 * vault-emission watchdog default — comfortably above the seconds-scale
 * healthy confirm latency so a momentarily-unconfirmed row never pages.
 */
export const CTX_SETTLEMENT_STUCK_THRESHOLD_MINUTES = 15;

/** `watchdog_alert_state` row key for this watchdog. */
const ALERT_STATE_NAME = 'ctx-settlement-stuck-watchdog';

/**
 * Fixed advisory-lock key for the single-flight (same sha256→int64
 * derivation as `stuckPayoutWatchdogLockKey`, distinct scope string).
 */
function ctxSettlementStuckLockKey(): bigint {
  const digest = createHash('sha256').update('loop:ctx-settlement-stuck-watchdog').digest();
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

export interface StuckCtxSettlementSummary {
  /** Total `confirmed_at IS NULL` rows older than the threshold. */
  total: number;
  /** Of `total`, how many have a `tx_hash` (submitted-but-unconfirmed). */
  submitted: number;
  /** Of `total`, how many have NO `tx_hash` (intent stuck pre-submit). */
  unsubmitted: number;
  /** Age in whole minutes of the oldest stuck row, or null when empty. */
  oldestAgeMinutes: number | null;
  /** `ctx_settlements.id` of the oldest stuck row, for the drill-down. */
  oldestId: string | null;
  /** `order_id` of the oldest stuck row. */
  oldestOrderId: string | null;
}

type WatchdogTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface StuckSqlRow extends Record<string, unknown> {
  total: number;
  submitted: number;
  oldestAgeSeconds: number | null;
  oldestId: string | null;
  oldestOrderId: string | null;
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
 * Counts the standing stuck-settlement backlog. Exported so admin/ops
 * surfaces (and tests) can read it without paging. Accepts either the pool
 * or a lock-holding transaction handle via the narrow `execute` shape (same
 * pattern as `listFailedPayoutBacklog`), which sees the two handles'
 * otherwise-divergent query-builder generics as one type.
 *
 * `confirmed_at IS NULL AND created_at < NOW() - threshold` = a settlement
 * attempt Loop has no landed confirmation for past the staleness window.
 */
export async function listStuckCtxSettlements(
  handle: Pick<typeof db, 'execute'> = db,
  thresholdMinutes: number = CTX_SETTLEMENT_STUCK_THRESHOLD_MINUTES,
): Promise<StuckCtxSettlementSummary> {
  const result = await handle.execute<StuckSqlRow>(sql`
    SELECT
      count(*)::int AS "total",
      count(*) FILTER (WHERE tx_hash IS NOT NULL)::int AS "submitted",
      EXTRACT(EPOCH FROM (NOW() - min(created_at)))::int AS "oldestAgeSeconds",
      (array_agg(id ORDER BY created_at))[1]::text AS "oldestId",
      (array_agg(order_id ORDER BY created_at))[1]::text AS "oldestOrderId"
    FROM ctx_settlements
    WHERE confirmed_at IS NULL
      AND created_at < NOW() - make_interval(mins => ${thresholdMinutes})
  `);
  const [row] = extractRows<StuckSqlRow>(result);
  const total = row?.total ?? 0;
  const submitted = row?.submitted ?? 0;
  const oldestAgeSeconds = row?.oldestAgeSeconds ?? null;
  return {
    total,
    submitted,
    unsubmitted: total - submitted,
    oldestAgeMinutes: oldestAgeSeconds === null ? null : Math.floor(oldestAgeSeconds / 60),
    oldestId: total === 0 ? null : (row?.oldestId ?? null),
    oldestOrderId: total === 0 ? null : (row?.oldestOrderId ?? null),
  };
}

/**
 * Delivery-confirming page for a standing stuck-settlement backlog. Returns
 * whether the webhook actually delivered so the caller latches the
 * fired-state only on real delivery (at-least-once).
 */
function notifyStuckCtxSettlements(
  summary: StuckCtxSettlementSummary,
  thresholdMinutes: number,
): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stuck CTX settlements',
    color: RED,
    description: truncate(
      `${summary.total} CTX settlement(s) have sat unconfirmed (\`confirmed_at IS NULL\`) past the ` +
        `${thresholdMinutes}-minute window — Loop forwarded user-paid XLM to CTX but holds no landed ` +
        `confirmation. ${summary.submitted} were submitted (a tx_hash exists — the XLM may have landed ` +
        `and only the confirmation was lost) and ${summary.unsubmitted} never got past intent. Reconcile ` +
        `against Horizon by the settlement's tx_hash / memo before any refund or re-submit — do NOT ` +
        `assume Loop is whole. This page repeats once per incident and re-arms when the backlog clears.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      { name: 'Total', value: String(summary.total), inline: true },
      { name: 'Submitted', value: String(summary.submitted), inline: true },
      { name: 'Unsubmitted', value: String(summary.unsubmitted), inline: true },
      {
        name: 'Oldest (min)',
        value: summary.oldestAgeMinutes === null ? '_n/a_' : String(summary.oldestAgeMinutes),
        inline: true,
      },
      {
        name: 'Example settlement',
        value:
          summary.oldestId === null
            ? '_none_'
            : truncate(`\`${escapeMarkdown(summary.oldestId)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
      {
        name: 'Example order',
        value:
          summary.oldestOrderId === null
            ? '_none_'
            : truncate(`\`${escapeMarkdown(summary.oldestOrderId)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * Upserts the persisted fired-state. Runs under the advisory lock, so no
 * row-level locking is needed — the advisory lock serialises every
 * reader/writer of this row fleet-wide.
 */
async function persistAlertActive(tx: WatchdogTx, active: boolean): Promise<void> {
  await tx
    .insert(watchdogAlertState)
    .values({ watchdogName: ALERT_STATE_NAME, alertActive: active })
    .onConflictDoUpdate({
      target: watchdogAlertState.watchdogName,
      set: { alertActive: active, updatedAt: sql`NOW()` },
    });
}

export interface CtxSettlementStuckWatchdogResult {
  /** True when another machine held the fleet-wide watchdog lock. */
  skippedLocked: boolean;
  /** True when this tick sent (and confirmed) the stuck-settlement page. */
  notified: boolean;
  /** The stuck-settlement total observed this tick (0 when skipped-locked). */
  stuck: number;
}

/**
 * NS-13: single-flighted fleet-wide via `pg_try_advisory_xact_lock` inside
 * a `db.transaction` (module doc-comment has the full rationale). Only the
 * lock holder reads the stuck set and manages the persisted fired-state.
 */
export async function runCtxSettlementStuckWatchdog(args?: {
  thresholdMinutes?: number;
}): Promise<CtxSettlementStuckWatchdogResult> {
  const thresholdMinutes = args?.thresholdMinutes ?? CTX_SETTLEMENT_STUCK_THRESHOLD_MINUTES;
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${ctxSettlementStuckLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false, stuck: 0 };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, ALERT_STATE_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    const summary = await listStuckCtxSettlements(tx, thresholdMinutes);
    if (summary.total === 0) {
      // Clean — re-arm so the NEXT incident pages fresh. Only write when a
      // fired state actually exists (keeps clean ticks write-free).
      if (alertActive) await persistAlertActive(tx, false);
      return { skippedLocked: false, notified: false, stuck: 0 };
    }
    if (alertActive) return { skippedLocked: false, notified: false, stuck: summary.total };

    // Confirmed-delivery ordering: await the send and persist active=true
    // only on success — a failed send stays unfired so the next tick
    // retries (at-least-once).
    const delivered = await notifyStuckCtxSettlements(summary, thresholdMinutes);
    if (!delivered) return { skippedLocked: false, notified: false, stuck: summary.total };
    await persistAlertActive(tx, true);
    return { skippedLocked: false, notified: true, stuck: summary.total };
  });
}
