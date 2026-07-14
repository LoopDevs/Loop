/**
 * CONV-WATCH-01 — `applyBinaryWatchdogAlert` fleet-wide fire-once fence
 * under contention (real postgres).
 *
 * `applyBinaryWatchdogAlert` is the shared `watchdog_alert_state`
 * fire-once gate. Two of its callers — `health.ts`
 * (`routeHealthChangeNotify`) and `discord/monitoring-circuit-breaker.ts`
 * (`notifyCircuitBreaker`) — run PER-MACHINE with no outer advisory
 * lock, so two Fly machines (or overlapping ticks) can invoke it
 * concurrently on the SAME `watchdogName` row. Without the fence both
 * read the pre-alert state, both decide "should page", both send, and
 * both persist — a single breach paging Discord MORE THAN ONCE.
 *
 * The fix wraps read-decide-send-persist in a `db.transaction` under a
 * `pg_advisory_xact_lock` keyed on the `watchdogName` (the same fence
 * `payments/stuck-payout-watchdog.ts` puts around this exact gate). This
 * suite drives TWO concurrent calls against real postgres +
 * `watchdog_alert_state` and asserts exactly ONE notify fires and the
 * row persists once. It is a DB-LEVEL key/row race — a mocked test can't
 * demonstrate it — so it must run against the live `loop_test` DB.
 *
 * Proven red against the un-fenced version: without the transaction +
 * advisory lock, both concurrent callers send (notify count = 2) and
 * both return `true`.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { watchdogAlertState } from '../../db/schema.js';
import { applyBinaryWatchdogAlert } from '../../credits/vaults/vault-watchdog-alert.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const WATCHDOG = 'conv-watch-01-fence-test';

/** Persisted `alert_active` for the test gate (`undefined` when no row). */
async function persistedActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, WATCHDOG));
  return row?.alertActive;
}

/** Count of persisted rows for the test gate (must never exceed 1). */
async function persistedRowCount(): Promise<number> {
  const rows = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, WATCHDOG));
  return rows.length;
}

describeIf('CONV-WATCH-01 watchdog-alert fire-once fence (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('fires exactly ONE alert when two callers race the same gate (false→true)', async () => {
    let sends = 0;
    // Widen the read→persist window so the (un-fenced) racing reads both
    // land before either persist — the fence must still collapse this to
    // a single send. On the fenced path only the lock WINNER ever reaches
    // this notifier; the loser blocks on the xact lock, then re-reads the
    // winner's committed `alert_active=true` and no-ops (never sends).
    const notifyActive = async (): Promise<boolean> => {
      sends += 1;
      await new Promise((r) => setTimeout(r, 100));
      return true;
    };
    const notifyRecovered = async (): Promise<boolean> => true;

    const race = (): Promise<boolean> =>
      applyBinaryWatchdogAlert({
        watchdogName: WATCHDOG,
        shouldBeActive: true,
        notifyActive,
        notifyRecovered,
      });

    const results = await Promise.all([race(), race()]);

    // Exactly one caller sent the page and reported the confirmed flip;
    // the other no-op'd (`false`). Un-fenced: sends === 2, both `true`.
    expect(sends).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);

    // The gate persisted once, active.
    expect(await persistedRowCount()).toBe(1);
    expect(await persistedActive()).toBe(true);
  });

  it('preserves the sequential dedup + re-arm semantics end-to-end (real postgres)', async () => {
    let actives = 0;
    let recovers = 0;
    const notifyActive = async (): Promise<boolean> => {
      actives += 1;
      return true;
    };
    const notifyRecovered = async (): Promise<boolean> => {
      recovers += 1;
      return true;
    };
    const call = (shouldBeActive: boolean): Promise<boolean> =>
      applyBinaryWatchdogAlert({
        watchdogName: WATCHDOG,
        shouldBeActive,
        notifyActive,
        notifyRecovered,
      });

    // First breach fires + latches.
    expect(await call(true)).toBe(true);
    // Still breaching: reads the persisted active state and no-ops.
    expect(await call(true)).toBe(false);
    expect(actives).toBe(1);
    expect(await persistedActive()).toBe(true);

    // Recovery fires the recovered notifier once and re-arms.
    expect(await call(false)).toBe(true);
    expect(recovers).toBe(1);
    expect(await persistedActive()).toBe(false);
  });

  it('does not latch (no row written) when the first-ever page fails to deliver', async () => {
    // At-least-once: an undelivered false→true page must NOT persist —
    // the fence must not leave a placeholder row behind (a later attempt
    // retries fresh). Guards against a fence implementation that
    // pre-inserts a row to lock it.
    const notifyActive = async (): Promise<boolean> => false; // undelivered
    const notifyRecovered = async (): Promise<boolean> => true;

    const fired = await applyBinaryWatchdogAlert({
      watchdogName: WATCHDOG,
      shouldBeActive: true,
      notifyActive,
      notifyRecovered,
    });

    expect(fired).toBe(false);
    expect(await persistedRowCount()).toBe(0);
    expect(await persistedActive()).toBeUndefined();
  });
});
