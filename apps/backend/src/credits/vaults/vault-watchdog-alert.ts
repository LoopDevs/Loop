/**
 * Small shared fire-once/re-arm helper over `watchdog_alert_state`
 * (migration 0055, `docs/invariants.md` INV-4's "paging dedup for the
 * fire-once watchdogs"). Callers:
 *   - `vault-drift-watcher.ts` (V5) — INV-V1/INV-V2 standing invariants
 *     that should page once per incident and re-arm on recovery. (Its
 *     sibling `treasury/hot-float-reconciliation.ts` deliberately does
 *     NOT use this — it follows R3-1's page-every-bad-run posture
 *     instead, since it runs on a much slower cadence; see that
 *     module's header.)
 *   - `health.ts` (`routeHealthChangeNotify`, CONV-WATCH-02) — the
 *     fleet-wide health-change page.
 *   - `discord/monitoring-circuit-breaker.ts` (`notifyCircuitBreaker`,
 *     BK-cbdedup) — circuit-breaker OPEN/Closed pages.
 *
 * ── Fleet-wide fire-once fence (CONV-WATCH-01) ─────────────────────
 * The whole read-decide-send-persist sequence runs inside ONE
 * `db.transaction` under a transaction-scoped advisory lock keyed on
 * the `watchdogName` (`pg_advisory_xact_lock`), so concurrent callers
 * of the SAME gate are serialised fleet-wide. This is the same fence
 * `payments/stuck-payout-watchdog.ts` (and `cursor-watchdog.ts`) put
 * around this exact `watchdog_alert_state` gate, and the same
 * per-entity `pg_advisory_xact_lock` idiom `admin/idempotency.ts` and
 * `users/favorites-handler.ts` use for their read-then-write critical
 * sections.
 *
 * It was NOT always safe: only `vault-drift-watcher.ts` runs its whole
 * tick under one fleet-wide `withAdvisoryLock`, so for THAT caller the
 * sequence was already serialised. But `health.ts` and the
 * circuit-breaker notifier call this helper per-machine with NO outer
 * lock — so before this fence two Fly machines (multiple machines /
 * overlapping ticks) could both read the pre-alert state, both decide
 * "should page", both send, and both persist, paging a single breach
 * MORE THAN ONCE. Locking on the NAME (not a row) fences the
 * first-ever transition too, when no `watchdog_alert_state` row exists
 * yet to lock; the loser of the race blocks on the lock, then re-reads
 * the winner's committed state below and no-ops. The Discord send is
 * awaited INSIDE the lock-holding transaction so the delivery decision
 * is race-free; `sendWebhook` is bounded by its AbortSignal timeout,
 * so the xact lock (and its pooled connection) is held only for that
 * bounded window — the same posture `stuck-payout-watchdog.ts`
 * documents and accepts.
 *
 * Contract: at-least-once, confirmed-delivery. `alertActive` flips
 * only AFTER the notifier's `sendWebhook` call resolves `true`; an
 * undelivered page (Discord outage, timeout) leaves the row unchanged
 * (never even inserted on a first-ever transition) so the NEXT tick
 * (any machine, since the state is in Postgres) re-attempts — never
 * silently dropped, never double-fired once delivered.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { watchdogAlertState } from '../../db/schema.js';

export interface ApplyBinaryWatchdogAlertArgs {
  /** Stable, globally-unique key for this incident dimension, e.g. `vault-drift-shares:LOOPUSD:mainnet`. */
  watchdogName: string;
  /** What the state SHOULD be after this tick's computation. */
  shouldBeActive: boolean;
  /** Called (and awaited) only on a false→true transition. Must resolve `true` on confirmed delivery. */
  notifyActive: () => Promise<boolean>;
  /** Called (and awaited) only on a true→false transition. Must resolve `true` on confirmed delivery. */
  notifyRecovered: () => Promise<boolean>;
}

/**
 * CONV-WATCH-01: transaction-scoped advisory-lock key for one
 * watchdogName's fire-once gate. sha256(namespaced name) → signed
 * int64 — the same derivation `payments/stuck-payout-watchdog.ts`
 * (`stuckPayoutWatchdogLockKey`), `admin/idempotency.ts`
 * (`idempotencyLockKey`) and `users/favorites-handler.ts`
 * (`favoritesLockKey`) use for their `pg_advisory_*_lock` keys.
 * Namespaced with `loop:watchdog-alert-gate:` so a gate lock can never
 * collide with a watcher's own tick single-flight lock (those hash
 * their fixed scope strings, e.g. `loop:stuck-payout-watchdog`) or
 * another subsystem's per-entity lock on the same raw name.
 */
function watchdogAlertGateLockKey(watchdogName: string): bigint {
  const digest = createHash('sha256').update(`loop:watchdog-alert-gate:${watchdogName}`).digest();
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

/**
 * Returns `true` when a page was sent AND confirmed delivered this
 * call (i.e. the persisted state actually moved); `false` when
 * nothing was due, or a due page failed to deliver (state left
 * unchanged for the next tick to retry).
 */
export async function applyBinaryWatchdogAlert(
  args: ApplyBinaryWatchdogAlertArgs,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    // CONV-WATCH-01 fire-once fence: serialise every concurrent caller
    // of THIS watchdogName's gate fleet-wide before the read-decide-
    // send-persist sequence below. A blocking transaction-scoped
    // advisory lock (auto-released at COMMIT/ROLLBACK), keyed on the
    // name so it also fences the first-ever transition when no row
    // exists yet to lock. The loser blocks here, then re-reads the
    // winner's committed state and no-ops. See the module header for
    // why the drift watcher's outer `withAdvisoryLock` did not cover
    // the un-locked `health.ts` / circuit-breaker callers.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${watchdogAlertGateLockKey(args.watchdogName)})`,
    );

    const [row] = await tx
      .select({ alertActive: watchdogAlertState.alertActive })
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, args.watchdogName));
    const wasActive = row?.alertActive ?? false;
    // Re-check under the lock: a caller queued behind the winner now
    // sees the winner's committed flip and no-ops (no duplicate page).
    if (wasActive === args.shouldBeActive) return false;

    const delivered = args.shouldBeActive
      ? await args.notifyActive()
      : await args.notifyRecovered();
    if (!delivered) return false;

    await tx
      .insert(watchdogAlertState)
      .values({ watchdogName: args.watchdogName, alertActive: args.shouldBeActive })
      .onConflictDoUpdate({
        target: watchdogAlertState.watchdogName,
        set: { alertActive: args.shouldBeActive, updatedAt: sql`NOW()` },
      });
    return true;
  });
}
