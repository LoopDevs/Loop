/**
 * Missing-CTX-settlement reconciliation watchdog (NS-13, deferred half).
 *
 * The sibling `ctx-settlement-stuck-watchdog.ts` catches settlements that
 * EXIST but never confirmed (`confirmed_at IS NULL` past the staleness
 * window). This is the other reconciliation gap: an order that legitimately
 * SHOULD have a `ctx_settlements` row but has NONE at all.
 *
 * Every order reaches `fulfilled` only through `procureOne` → `payCtxOrder`
 * (`orders/procure-one.ts`), and `payCtxOrder` ALWAYS writes the settlement
 * row (`getOrCreateCtxSettlement`, or `backfillCtxSettlementFromChain` on the
 * memo-scan path) BEFORE it marks the order fulfilled. So by the time an
 * order is `fulfilled`, its settlement row must already exist. A `fulfilled`
 * order with NO `ctx_settlements` row is therefore an anomaly — the durable
 * evidence that Loop paid CTX for that order is simply gone (a bad manual
 * SQL edit, a partial restore, a row deleted out from under the FK, or a
 * fulfillment path that somehow bypassed `payCtxOrder`). Left undetected it
 * is a silent money-out / reconciliation gap: Loop's XLM/USDC left the
 * operator wallet with no record tying it to the order.
 *
 * NOT every settlement-less fulfilled order is a gap, though — two classes
 * legitimately have none, and this watchdog EXEMPTS both so they never
 * false-page (owner's decided baseline):
 *
 *   1. Credit-funded fulfillments (`payment_method = 'credit'`). Only the
 *      on-chain-funded methods (`xlm` / `usdc` / `loop_asset`) carry a CTX
 *      settlement leg the reconciliation must account for; `credit` orders
 *      are excluded up front.
 *
 *   2. Pre-cutover orders — created before the CTX-settlement system went
 *      live (migration 0045, "hardening A4"). Those orders settled to CTX
 *      through the legacy proxy path that never wrote `ctx_settlements`, so
 *      a missing row is expected, not a gap.
 *
 * The cutover is `LOOP_SETTLEMENT_RECONCILE_SINCE` when an operator has
 * pinned the exact A4 go-live timestamp; otherwise it falls back to the
 * earliest `ctx_settlements.created_at` — the empirical moment the system
 * first recorded a settlement, before which no on-chain order could have had
 * one written by the live system. If there is neither an override nor any
 * settlement row at all (the system has never recorded one), there is no
 * baseline to reconcile against and the watchdog reports nothing rather than
 * flagging every historical order — a deliberate fail-quiet on "not live yet".
 *
 * Same fleet-safe shape as the stuck sibling and `stuck-payout-watchdog.ts`:
 *   - single-flights on a transaction-scoped advisory lock
 *     (`pg_try_advisory_xact_lock`) so exactly one Fly machine runs the query
 *     and manages the fired-state per tick;
 *   - fire-once / re-arm state is PERSISTED in `watchdog_alert_state`
 *     (ADR-038 D2 at-least-once): `alert_active` flips `true` only after
 *     `sendWebhook` confirms delivery — a failed send stays unfired so the
 *     next tick (any machine) retries — and a clean tick resets it so the
 *     next distinct incident pages fresh.
 *
 * Detection + paging only — this NEVER moves money. Reconstructing the lost
 * settlement (was CTX actually paid? by which tx?) is an operator/Horizon
 * task, not something to auto-write here.
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

/**
 * Reconciliation cadence. Deliberately slower than the stuck sibling's
 * 60s: a genuinely-missing settlement is a STANDING condition (nothing
 * heals it on its own), so there is no latency race to win — an accounting
 * sweep every few minutes is ample, and the fire-once dedup keeps the
 * channel quiet between distinct incidents regardless. Own timer inside the
 * procurement worker, single-flighted fleet-wide.
 */
export const CTX_SETTLEMENT_RECONCILE_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

/** `watchdog_alert_state` row key for this watchdog (distinct from the stuck sibling). */
const ALERT_STATE_NAME = 'ctx-settlement-reconcile-watchdog';

/**
 * Fixed advisory-lock key (same sha256→int64 derivation as the stuck
 * sibling / `stuckPayoutWatchdogLockKey`, distinct scope string so the two
 * settlement watchdogs never contend on one lock).
 */
function ctxSettlementReconcileLockKey(): bigint {
  const digest = createHash('sha256').update('loop:ctx-settlement-reconcile-watchdog').digest();
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

export interface MissingCtxSettlementSummary {
  /**
   * Count of fulfilled, on-chain-funded, post-cutover orders with NO
   * `ctx_settlements` row — genuinely-missing settlements to reconcile.
   */
  total: number;
  /** Age in whole minutes (since order creation) of the oldest such order, or null when none. */
  oldestAgeMinutes: number | null;
  /** `orders.id` of the oldest offending order, for the drill-down. */
  oldestOrderId: string | null;
  /** `payment_method` of the oldest offending order. */
  oldestPaymentMethod: string | null;
}

type WatchdogTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface MissingSqlRow extends Record<string, unknown> {
  total: number;
  oldestAgeSeconds: number | null;
  oldestOrderId: string | null;
  oldestPaymentMethod: string | null;
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
 * Counts the standing missing-settlement backlog. Exported so admin/ops
 * surfaces (and tests) can read it without paging. Accepts either the pool
 * or a lock-holding transaction handle via the narrow `execute` shape (same
 * pattern as `listStuckCtxSettlements`).
 *
 * Cutover = `LOOP_SETTLEMENT_RECONCILE_SINCE` (operator-pinned A4 go-live)
 * COALESCEd onto the earliest `ctx_settlements.created_at`. When both are
 * absent (no override, zero settlement rows) the cutover is NULL and the
 * result is empty — nothing to reconcile against yet.
 */
export async function listMissingCtxSettlements(
  handle: Pick<typeof db, 'execute'> = db,
  since: Date | undefined = env.LOOP_SETTLEMENT_RECONCILE_SINCE,
): Promise<MissingCtxSettlementSummary> {
  const sinceParam = since ? sql`${since.toISOString()}::timestamptz` : sql`NULL::timestamptz`;
  const result = await handle.execute<MissingSqlRow>(sql`
    WITH cutover AS (
      SELECT COALESCE(
        ${sinceParam},
        (SELECT min(created_at) FROM ctx_settlements)
      ) AS ts
    )
    SELECT
      count(*)::int AS "total",
      EXTRACT(EPOCH FROM (NOW() - min(o.created_at)))::int AS "oldestAgeSeconds",
      (array_agg(o.id ORDER BY o.created_at))[1]::text AS "oldestOrderId",
      (array_agg(o.payment_method ORDER BY o.created_at))[1]::text AS "oldestPaymentMethod"
    FROM orders o, cutover c
    WHERE c.ts IS NOT NULL
      AND o.state = 'fulfilled'
      AND o.payment_method IN ('xlm', 'usdc', 'loop_asset')
      AND o.created_at >= c.ts
      AND NOT EXISTS (
        SELECT 1 FROM ctx_settlements s WHERE s.order_id = o.id
      )
  `);
  const [row] = extractRows<MissingSqlRow>(result);
  const total = row?.total ?? 0;
  const oldestAgeSeconds = row?.oldestAgeSeconds ?? null;
  return {
    total,
    oldestAgeMinutes: oldestAgeSeconds === null ? null : Math.floor(oldestAgeSeconds / 60),
    oldestOrderId: total === 0 ? null : (row?.oldestOrderId ?? null),
    oldestPaymentMethod: total === 0 ? null : (row?.oldestPaymentMethod ?? null),
  };
}

/**
 * Delivery-confirming page for a standing missing-settlement backlog.
 * Returns whether the webhook actually delivered so the caller latches the
 * fired-state only on real delivery (at-least-once).
 */
function notifyMissingCtxSettlements(summary: MissingCtxSettlementSummary): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Missing CTX settlements',
    color: RED,
    description: truncate(
      `${summary.total} fulfilled, on-chain-funded order(s) created after the settlement-system ` +
        `cutover have NO \`ctx_settlements\` row — every fulfilled order settles to CTX through ` +
        `\`payCtxOrder\`, which writes that row BEFORE fulfillment, so a missing row means the durable ` +
        `evidence that Loop paid CTX for the order is gone (a bad manual edit, a partial restore, or a ` +
        `path that bypassed the settlement write). Reconcile each order against Horizon by its memo / ` +
        `operator outbound payments and re-record the settlement before treating Loop's float as whole. ` +
        `Credit-funded and pre-cutover orders are exempt and never counted here. This page repeats once ` +
        `per incident and re-arms when the backlog clears.`,
      DESCRIPTION_MAX,
    ),
    fields: [
      { name: 'Missing', value: String(summary.total), inline: true },
      {
        name: 'Oldest (min)',
        value: summary.oldestAgeMinutes === null ? '_n/a_' : String(summary.oldestAgeMinutes),
        inline: true,
      },
      {
        name: 'Method',
        value:
          summary.oldestPaymentMethod === null
            ? '_n/a_'
            : truncate(`\`${escapeMarkdown(summary.oldestPaymentMethod)}\``, FIELD_VALUE_MAX),
        inline: true,
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

export interface CtxSettlementReconcileWatchdogResult {
  /** True when another machine held the fleet-wide watchdog lock. */
  skippedLocked: boolean;
  /** True when this tick sent (and confirmed) the missing-settlement page. */
  notified: boolean;
  /** The missing-settlement total observed this tick (0 when skipped-locked). */
  missing: number;
}

/**
 * NS-13 reconciliation half: single-flighted fleet-wide via
 * `pg_try_advisory_xact_lock` inside a `db.transaction` (module doc-comment
 * has the full rationale). Only the lock holder reads the missing set and
 * manages the persisted fired-state.
 */
export async function runCtxSettlementReconcileWatchdog(args?: {
  since?: Date;
}): Promise<CtxSettlementReconcileWatchdogResult> {
  const since = args?.since ?? env.LOOP_SETTLEMENT_RECONCILE_SINCE;
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${ctxSettlementReconcileLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return { skippedLocked: true, notified: false, missing: 0 };
    }

    const [alertRow] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, ALERT_STATE_NAME));
    const alertActive = alertRow?.alertActive ?? false;

    // Recompute the backlog under the lock, immediately before the paging
    // decision (race-free with any concurrent reconciliation write).
    const summary = await listMissingCtxSettlements(tx, since);
    if (summary.total === 0) {
      // Clean — re-arm so the NEXT incident pages fresh. Only write when a
      // fired state actually exists (keeps clean ticks write-free).
      if (alertActive) await persistAlertActive(tx, false);
      return { skippedLocked: false, notified: false, missing: 0 };
    }
    if (alertActive) return { skippedLocked: false, notified: false, missing: summary.total };

    // Confirmed-delivery ordering: await the send and persist active=true
    // only on success — a failed send stays unfired so the next tick
    // retries (at-least-once).
    const delivered = await notifyMissingCtxSettlements(summary);
    if (!delivered) return { skippedLocked: false, notified: false, missing: summary.total };
    await persistAlertActive(tx, true);
    return { skippedLocked: false, notified: true, missing: summary.total };
  });
}
