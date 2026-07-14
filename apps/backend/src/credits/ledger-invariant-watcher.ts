/**
 * Ledger-invariant watcher (hardening C1, 2026-07 plan; ADR 009).
 *
 * `user_credits.balance_minor` is a materialised mirror of
 * `SUM(credit_transactions.amount_minor)` per (user, currency). Every
 * writer maintains both sides in one transaction, so divergence means
 * a real bug (a writer that desynced the mirror) or manual DB surgery
 * — either way the money ledger can no longer be trusted until it is
 * explained. The check existed in three ad-hoc forms (the
 * `/api/admin/reconciliation` endpoint, the shell script
 * `scripts/check-ledger-invariant.ts`, and a pure unit-tested
 * function) but NOTHING ran it on a schedule — a slow drift bug in
 * production had no mechanical detector, only a human remembering to
 * look.
 *
 * This worker runs `computeLedgerDriftSql` on an interval (default
 * daily) and pages the Discord monitoring channel whenever drift
 * exists. Deliberately NO transition dedup: unresolved ledger drift
 * is a drop-everything condition and a daily re-page while it
 * persists is the desired behaviour, not noise. (Contrast the
 * asset-drift watcher, which ticks every 5 minutes and therefore
 * needs transition-paged state.)
 *
 * Multi-machine: the tick single-flights on a transaction-scoped
 * advisory lock, so with N Fly machines exactly one runs the (full-
 * table aggregate) query per tick window and exactly one pages.
 * Transaction-scoped (`pg_try_advisory_xact_lock`) rather than
 * session-scoped because the client is a pool — a session lock's
 * unlock could land on a different connection.
 *
 * Wiring mirrors the sibling workers (`auth-row-purge.ts`,
 * `asset-drift-watcher.ts`): `start…/stop…` timer pair gated in
 * `index.ts` on `LOOP_WORKERS_ENABLED`, runtime-health registration,
 * per-tick errors swallowed so a transient DB blip doesn't kill the
 * interval.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { computeLedgerDriftSql, type DriftEntry } from './ledger-invariant.js';
import { notifyLedgerDrift } from '../discord.js';
import { setMoneyIntegrityBreach } from '../metrics.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'ledger-invariant-watcher' });

/**
 * Fixed advisory-lock key for the single-flight (same sha256→int64
 * derivation as `adjustmentCapLockKey`, fixed scope string).
 */
function ledgerInvariantLockKey(): bigint {
  const digest = createHash('sha256').update('loop:ledger-invariant-watcher').digest();
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

export interface LedgerInvariantTickResult {
  /** True when another machine held the single-flight lock this tick. */
  skipped: boolean;
  /** Drifted (user, currency) pairs found (capped at the query limit). */
  drift: DriftEntry[];
  /** True when a Discord page was sent this tick. */
  notified: boolean;
}

/**
 * Single check tick. Exported so tests (and an operator one-shot) can
 * drive it directly.
 */
export async function runLedgerInvariantTick(args?: {
  limit?: number;
}): Promise<LedgerInvariantTickResult> {
  const limit = args?.limit ?? 1000;
  const drift = await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${ledgerInvariantLockKey()}) AS locked`,
    );
    const lockRows = Array.isArray(lockResult)
      ? (lockResult as Array<{ locked: boolean }>)
      : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
    if (lockRows[0]?.locked !== true) {
      return null; // another machine is running this tick's check
    }
    return await computeLedgerDriftSql(tx, limit);
  });

  if (drift === null) {
    return { skipped: true, drift: [], notified: false };
  }
  if (drift.length === 0) {
    return { skipped: false, drift: [], notified: false };
  }

  log.error(
    { driftCount: drift.length, sample: drift.slice(0, 5) },
    'LEDGER INVARIANT VIOLATED — user_credits mirror disagrees with credit_transactions sum',
  );
  notifyLedgerDrift({
    driftCount: drift.length,
    limitHit: drift.length >= limit,
    sample: drift.slice(0, 5).map((d) => ({
      userId: d.userId,
      currency: d.currency,
      balanceMinor: d.balanceMinor,
      ledgerSumMinor: d.ledgerSumMinor,
      deltaMinor: d.deltaMinor,
    })),
  });
  return { skipped: false, drift, notified: true };
}

// ─── Interval loop ────────────────────────────────────────────────────────

let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic ledger-invariant check. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED`.
 */
export function startLedgerInvariantWatcher(args?: { intervalMs?: number }): void {
  if (checkTimer !== null) return;
  const intervalMs = args?.intervalMs ?? env.LOOP_LEDGER_INVARIANT_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('ledger_invariant_watcher', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting ledger-invariant watcher');
  const tick = async (): Promise<void> => {
    try {
      const r = await runLedgerInvariantTick();
      if (r.notified) {
        log.error({ driftCount: r.drift.length }, 'Ledger-invariant tick paged Discord');
      }
      // NS-02 / FT-07: markWorkerTickSuccess below only proves the tick
      // RAN — it must NOT be the only signal, or a live ledger drift
      // reads as a healthy worker. A tick that actually computed the
      // check (not lock-skipped) records the STANDING breach state on
      // the money-integrity gauge, so a persisting drift stays visible
      // on /metrics independent of the Discord page. A lock-skip leaves
      // the last-known value untouched (this machine has no fresh read).
      if (!r.skipped) {
        setMoneyIntegrityBreach('ledger_invariant', r.drift.length > 0);
      }
      markWorkerTickSuccess('ledger_invariant_watcher');
    } catch (err) {
      markWorkerTickFailure('ledger_invariant_watcher', err);
      log.error({ err }, 'Ledger-invariant tick failed');
    }
  };
  void tick();
  checkTimer = setInterval(() => void tick(), intervalMs);
  checkTimer.unref();
}

export function stopLedgerInvariantWatcher(): void {
  if (checkTimer === null) return;
  clearInterval(checkTimer);
  checkTimer = null;
  markWorkerStopped('ledger_invariant_watcher');
  log.info('Ledger-invariant watcher stopped');
}
