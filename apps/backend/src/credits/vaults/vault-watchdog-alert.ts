/**
 * Small shared fire-once/re-arm helper over `watchdog_alert_state`
 * (migration 0055, `docs/invariants.md` INV-4's "paging dedup for the
 * fire-once watchdogs"). Used by `vault-drift-watcher.ts` (V5) — its
 * INV-V1/INV-V2 dimensions are STANDING invariants that should page
 * once per incident and re-arm on recovery. (Its sibling
 * `treasury/hot-float-reconciliation.ts` deliberately does NOT use
 * this — it follows R3-1's page-every-bad-run posture instead, since
 * it runs on a much slower cadence; see that module's header.)
 * `vault-drift-watcher.ts` runs its whole tick body under ONE
 * fleet-wide `withAdvisoryLock`, so — unlike
 * `credits/vaults/vault-emissions.ts`'s `runVaultEmissionStuckWatchdog`,
 * which is independently scheduled and takes its OWN
 * `pg_try_advisory_xact_lock` — this helper doesn't need a second
 * lock layer; it just needs the read-decide-send-persist sequence to
 * be correct within an already-serialized caller.
 *
 * Contract: at-least-once, confirmed-delivery. `alertActive` flips
 * only AFTER the notifier's `sendWebhook` call resolves `true`; an
 * undelivered page (Discord outage, timeout) leaves the row
 * unchanged so the NEXT tick (any machine, since the state is in
 * Postgres) re-attempts — never silently dropped, never double-fired
 * once delivered.
 */
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
 * Returns `true` when a page was sent AND confirmed delivered this
 * call (i.e. the persisted state actually moved); `false` when
 * nothing was due, or a due page failed to deliver (state left
 * unchanged for the next tick to retry).
 */
export async function applyBinaryWatchdogAlert(
  args: ApplyBinaryWatchdogAlertArgs,
): Promise<boolean> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, args.watchdogName));
  const wasActive = row?.alertActive ?? false;
  if (wasActive === args.shouldBeActive) return false;

  const delivered = args.shouldBeActive ? await args.notifyActive() : await args.notifyRecovered();
  if (!delivered) return false;

  await db
    .insert(watchdogAlertState)
    .values({ watchdogName: args.watchdogName, alertActive: args.shouldBeActive })
    .onConflictDoUpdate({
      target: watchdogAlertState.watchdogName,
      set: { alertActive: args.shouldBeActive, updatedAt: sql`NOW()` },
    });
  return true;
}
