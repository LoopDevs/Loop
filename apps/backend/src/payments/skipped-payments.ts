/**
 * Skipped-deposit retry ledger (comprehensive-audit 2026-06-11, CRIT #1/#2).
 *
 * The payment watcher advances its Horizon cursor past every record
 * on a page — including payments it could not process this tick
 * (oracle outage during the amount check, A4-110 missing credit row,
 * an unexpected error from `markOrderPaid`). Before this module, a
 * skipped payment was *never re-scanned*: the cursor had moved past
 * it, the user's funds sat in the deposit account, and the order
 * silently expired.
 *
 * Every skip is now persisted here BEFORE the cursor advances, and
 * `retrySkippedPayments` re-evaluates pending rows at the start of
 * each watcher tick. A row resolves when the order transitions to
 * `paid` (or already did via another path), and is abandoned — with
 * an ops alert — when the order is no longer pending or the attempt
 * budget is exhausted.
 *
 * The raw Horizon payment record is snapshotted as jsonb so the
 * retry path replays the exact same matching/validation logic as the
 * live path without a Horizon round-trip.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentWatcherSkips } from '../db/schema.js';
import { logger } from '../logger.js';
import { HorizonPaymentSchema, type HorizonPayment } from './horizon.js';
import {
  notifyDepositSkipRecorded,
  notifyDepositSkipAbandoned,
  notifyUnrecognizedDepositRecorded,
} from '../discord/monitoring.js';
import { refundDeposit } from './deposit-refund.js';

/**
 * A6: is auto-refund of late deposits enabled? Read LIVE from
 * process.env (like the kill switches) so an operator flip takes
 * effect on the next sweep without a redeploy. Declared in env.ts for
 * validation + .env.example parity.
 */
function isDepositRefundAutoEnabled(): boolean {
  const v = (process.env['LOOP_DEPOSIT_REFUND_AUTO'] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * A6 auto path: refund a just-abandoned late deposit. Never throws — an
 * auto-refund failure must not abort the sweep; the caller alerts so
 * ops can refund manually. Returns true iff the deposit was refunded
 * (or was already refunded).
 *
 * Recovery note (money-review P2-a): a deposit whose refund hits an
 * AMBIGUOUS submit error is held in `refunding` (fail-closed, never
 * double-paid). The retry-sweep only re-drives `pending` skips, so in a
 * fully-auto deployment a held `refunding` row is NOT auto-re-driven —
 * recovery is operator-driven: the `notifyDepositSkipAbandoned` alert
 * fired below prompts an operator to re-POST the refund endpoint (which
 * re-checks Horizon + stale-reclaims). Funds are never lost (they sit
 * at the operator==deposit account); this is a liveness note, not a
 * safety one. A scheduled re-driver of stale `refunding` rows is a
 * future enhancement for high-volume auto mode.
 */
async function tryAutoRefund(paymentId: string): Promise<boolean> {
  try {
    const res = await refundDeposit(paymentId);
    if (res.kind === 'refunded' || res.kind === 'already_refunded') {
      log.info({ paymentId, txHash: res.txHash }, 'A6: late deposit auto-refunded to sender');
      return true;
    }
    log.warn({ paymentId, result: res.kind }, 'A6: auto-refund did not complete');
    return false;
  } catch (err) {
    log.error({ err, paymentId }, 'A6: auto-refund threw — leaving abandoned for manual refund');
    return false;
  }
}

const log = logger.child({ area: 'payment-watcher-skips' });

export type SkipReason =
  | 'asset_mismatch'
  | 'amount_insufficient'
  | 'missing_credit_row'
  | 'processing_error'
  // T0-1: memo maps to a real order that's no longer pending (a late or
  // duplicate deposit). Its retry resolves to `order_gone` → abandon →
  // refundable via A6.
  | 'order_gone'
  // AUDIT-2 finding C: value delivered TO the deposit address (a
  // successful payment/path-payment op, `to === account`) that matches
  // NO configured rail at all — wrong/no memo, or an asset/issuer/
  // amount no order or allowlist recognizes. Previously silently
  // dropped (`no_match`/`no_memo` → bare `break;`, no DB row, cursor
  // still advances) — the exact stranded-deposit shape INV-6 exists to
  // rule out. Distinct from `order_gone` (memo DID resolve to a real,
  // no-longer-pending order) — here the memo/asset never resolved to
  // anything at all, so there is no `orderId` to attach.
  | 'unrecognized_deposit';

/**
 * Attempt budget for rows that keep failing with the same reason.
 * At the production tick cadence (30s) this is roughly a day of
 * retries — long enough for an oracle outage or an ops fix of a
 * corrupted credit row, short enough that a permanently-wrong
 * deposit stops consuming sweep cycles and gets escalated instead.
 */
export const MAX_SKIP_ATTEMPTS = 2880;

/**
 * Reasons that page ops the moment the first skip is recorded. These
 * need an internal bug or corrupt state to trigger, so a per-row page
 * is safe. `unrecognized_deposit` is deliberately NOT here — it is
 * externally + cheaply triggerable (the deposit address is public), so
 * it routes to the throttled + rolled-up `notifyUnrecognizedDeposit-
 * Recorded` instead (see `recordSkip` below), not this per-row pager.
 */
const ALERT_ON_FIRST_RECORD: ReadonlySet<SkipReason> = new Set([
  'missing_credit_row',
  'processing_error',
]);

export interface SkipRow {
  paymentId: string;
  memo: string;
  orderId: string | null;
  reason: SkipReason;
  payment: unknown;
  attempts: number;
}

/**
 * Persist (or bump) a skip. Keyed on the Horizon payment id so a
 * replayed cursor or a retry tick lands on the same row. Rows that
 * already reached `resolved` / `abandoned` are never reopened.
 *
 * Callers MUST await this before advancing the watcher cursor — a
 * failed insert throws so the tick aborts with the cursor parked
 * before the un-persisted skip (the pre-fix behaviour, which is
 * safe: the page is simply re-read next tick).
 */
export async function recordSkip(args: {
  payment: HorizonPayment;
  memo: string;
  orderId: string | null;
  reason: SkipReason;
  detail?: string | undefined;
}): Promise<void> {
  const inserted = await db
    .insert(paymentWatcherSkips)
    .values({
      paymentId: args.payment.id,
      memo: args.memo,
      orderId: args.orderId,
      reason: args.reason,
      payment: args.payment,
      lastError: args.detail ?? null,
    })
    .onConflictDoUpdate({
      target: paymentWatcherSkips.paymentId,
      set: {
        attempts: sql`${paymentWatcherSkips.attempts} + 1`,
        reason: args.reason,
        lastError: args.detail ?? null,
        updatedAt: sql`NOW()`,
      },
      setWhere: sql`${paymentWatcherSkips.status} = 'pending'`,
    })
    .returning({ attempts: paymentWatcherSkips.attempts });

  const attempts = inserted[0]?.attempts ?? 0;
  log.warn(
    {
      paymentId: args.payment.id,
      memo: args.memo,
      orderId: args.orderId,
      reason: args.reason,
      detail: args.detail,
      attempts,
    },
    'Deposit skipped — recorded for retry before cursor advance',
  );
  // Alert only on the FIRST record of a given payment id (`attempts === 1`)
  // — a sweep retry bumps `attempts` and must not re-page the same row.
  if (attempts === 1) {
    if (args.reason === 'unrecognized_deposit') {
      // AUDIT-2 finding C: externally + cheaply triggerable (public
      // deposit address), so this goes through the throttled + rolled-up
      // pager rather than one page per row. The DB row above is written
      // unconditionally regardless — recovery visibility is never
      // throttled, only the Discord page.
      notifyUnrecognizedDepositRecorded({
        paymentId: args.payment.id,
        detail: args.detail ?? null,
      });
    } else if (ALERT_ON_FIRST_RECORD.has(args.reason)) {
      notifyDepositSkipRecorded({
        paymentId: args.payment.id,
        orderId: args.orderId,
        reason: args.reason,
        detail: args.detail ?? null,
      });
    }
  }
}

export async function listPendingSkips(limit = 100): Promise<SkipRow[]> {
  const rows = await db
    .select({
      paymentId: paymentWatcherSkips.paymentId,
      memo: paymentWatcherSkips.memo,
      orderId: paymentWatcherSkips.orderId,
      reason: paymentWatcherSkips.reason,
      payment: paymentWatcherSkips.payment,
      attempts: paymentWatcherSkips.attempts,
    })
    .from(paymentWatcherSkips)
    .where(sql`${paymentWatcherSkips.status} = 'pending'`)
    .orderBy(paymentWatcherSkips.createdAt)
    .limit(limit);
  return rows as SkipRow[];
}

/**
 * ADR 037 support action — re-open an abandoned skip row so the
 * sweep retries it with a fresh attempt budget. The `status =
 * 'abandoned'` guard makes the write idempotent and refuses to
 * touch `pending` / `resolved` rows; the caller maps a null return
 * to "not abandoned / not found". Attempts reset to 0 so the
 * MAX_SKIP_ATTEMPTS budget restarts from scratch.
 */
export async function reopenAbandonedSkip(
  paymentId: string,
): Promise<{ paymentId: string; attempts: number } | null> {
  const rows = await db
    .update(paymentWatcherSkips)
    .set({ status: 'pending', attempts: 0, lastError: null, updatedAt: sql`NOW()` })
    .where(
      sql`${paymentWatcherSkips.paymentId} = ${paymentId} AND ${paymentWatcherSkips.status} = 'abandoned'`,
    )
    .returning({
      paymentId: paymentWatcherSkips.paymentId,
      attempts: paymentWatcherSkips.attempts,
    });
  const row = rows[0];
  if (row === undefined) return null;
  log.info({ paymentId }, 'Abandoned skip row reopened for retry (admin action)');
  return row;
}

async function setStatus(paymentId: string, status: 'resolved' | 'abandoned'): Promise<void> {
  await db
    .update(paymentWatcherSkips)
    .set({ status, updatedAt: sql`NOW()` })
    .where(sql`${paymentWatcherSkips.paymentId} = ${paymentId}`);
}

/**
 * Outcome contract the watcher's per-payment processor reports back
 * so the sweep can route a retried row. Mirrors the live-tick paths:
 * `paid` / `already_paid` resolve the row; `order_gone` abandons it
 * (the order left `pending_payment` without this deposit — expiry or
 * another payment won); a skip outcome bumps the attempt counter.
 */
export type RetryOutcome =
  | { kind: 'paid' }
  | { kind: 'already_paid' }
  | { kind: 'order_gone' }
  | { kind: 'skip'; reason: SkipReason; orderId: string | null; detail?: string | undefined };

export interface SweepResult {
  retried: number;
  resolved: number;
  abandoned: number;
  stillPending: number;
}

/**
 * Re-evaluate pending skip rows through `process` (the watcher's
 * shared per-payment processor). Never throws — a sweep failure must
 * not block fresh-deposit processing; each row is isolated so one
 * poisoned snapshot can't starve its neighbours.
 */
export async function retrySkippedPayments(
  process: (payment: HorizonPayment) => Promise<RetryOutcome>,
): Promise<SweepResult> {
  const result: SweepResult = { retried: 0, resolved: 0, abandoned: 0, stillPending: 0 };
  let rows: SkipRow[];
  try {
    rows = await listPendingSkips();
  } catch (err) {
    log.error({ err }, 'Skip-sweep list failed — will retry next tick');
    return result;
  }

  for (const row of rows) {
    result.retried++;
    try {
      const parsed = HorizonPaymentSchema.safeParse(row.payment);
      if (!parsed.success) {
        // A snapshot that no longer parses can never be replayed —
        // abandon loudly rather than retrying forever.
        await abandon(row, 'snapshot failed schema parse');
        result.abandoned++;
        continue;
      }
      const outcome = await process(parsed.data);
      if (outcome.kind === 'paid' || outcome.kind === 'already_paid') {
        await setStatus(row.paymentId, 'resolved');
        result.resolved++;
        log.info(
          { paymentId: row.paymentId, memo: row.memo, attempts: row.attempts },
          'Previously-skipped deposit recovered',
        );
        continue;
      }
      if (outcome.kind === 'order_gone') {
        // A6: a late deposit (order expired before it landed). In
        // auto-refund mode, return it to the sender instead of leaving
        // it abandoned for a manual operator button-press.
        if (isDepositRefundAutoEnabled()) {
          await setStatus(row.paymentId, 'abandoned'); // durable state the refund claims
          const refunded = await tryAutoRefund(row.paymentId);
          result.abandoned++;
          if (!refunded) {
            // Auto-refund didn't complete — surface it so ops refunds
            // manually rather than the deposit silently sitting.
            notifyDepositSkipAbandoned({
              paymentId: row.paymentId,
              orderId: row.orderId,
              reason: row.reason,
              attempts: row.attempts,
              note: 'late deposit — auto-refund did not complete; refund manually',
            });
          }
          continue;
        }
        await abandon(row, 'order no longer pending_payment');
        result.abandoned++;
        continue;
      }
      // Still skipping. Bump attempts via recordSkip (same row, same
      // key); abandon when the budget is exhausted.
      await recordSkip({
        payment: parsed.data,
        memo: row.memo,
        orderId: outcome.orderId ?? row.orderId,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      if (row.attempts + 1 >= MAX_SKIP_ATTEMPTS) {
        await abandon(row, `attempt budget exhausted (${MAX_SKIP_ATTEMPTS})`);
        result.abandoned++;
      } else {
        result.stillPending++;
      }
    } catch (err) {
      // Row-level isolation: log and move on; the row stays pending
      // and the next sweep retries it.
      log.error(
        { err, paymentId: row.paymentId, memo: row.memo },
        'Skip-sweep row failed — left pending for next tick',
      );
      result.stillPending++;
    }
  }
  return result;
}

async function abandon(row: SkipRow, note: string): Promise<void> {
  await setStatus(row.paymentId, 'abandoned');
  log.error(
    {
      paymentId: row.paymentId,
      memo: row.memo,
      orderId: row.orderId,
      reason: row.reason,
      attempts: row.attempts,
      note,
    },
    'Skipped deposit abandoned — user funds may need manual reconciliation',
  );
  notifyDepositSkipAbandoned({
    paymentId: row.paymentId,
    orderId: row.orderId,
    reason: row.reason,
    attempts: row.attempts,
    note,
  });
}
