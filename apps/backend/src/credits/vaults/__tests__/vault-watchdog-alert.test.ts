import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

/**
 * `applyBinaryWatchdogAlert` — the shared fire-once/re-arm helper V5's
 * two new watchers (`vault-drift-watcher.ts`,
 * `treasury/hot-float-reconciliation.ts`) build on. Table-routed FIFO
 * db mock, same convention as
 * `payments/__tests__/operator-float-reconciliation.test.ts`.
 *
 * CONV-WATCH-01: the helper now runs its read-decide-send-persist under
 * `db.transaction` + a `pg_advisory_xact_lock` (fire-once fence). The
 * mock therefore exposes `transaction(cb)` (invokes `cb(tx)`) and a
 * `tx.execute` no-op standing in for the advisory-lock statement; the
 * decision logic these unit tests assert is unchanged. The DB-level
 * fire-once-under-contention behaviour the lock actually provides is
 * proven by the real-postgres suite `vault-watchdog-alert-fence.test.ts`
 * (a mocked lock can't demonstrate a row/key fence).
 */

const { dbState, dbMock } = vi.hoisted(() => {
  const state = {
    selectQueues: new Map<string, unknown[][]>(),
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
    tableNameOf: (_t: unknown): string => '',
  };
  const nextRows = (table: unknown): unknown[] => {
    const q = state.selectQueues.get(state.tableNameOf(table));
    return q !== undefined && q.length > 0 ? (q.shift() as unknown[]) : [];
  };
  const select = (): unknown => ({
    from: (table: unknown): unknown => ({
      where: async () => nextRows(table),
    }),
  });
  const insert = (table: unknown): unknown => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async (args: { set: Record<string, unknown> }) => {
        state.inserts.push({ table: state.tableNameOf(table), values: v });
        state.updates.push({ table: state.tableNameOf(table), set: args.set });
      },
    }),
  });
  // The `tx` handed to the `db.transaction` callback: the advisory-lock
  // `execute` is a no-op here (the lock's real effect is exercised in the
  // integration suite), while `select`/`insert` route through the same
  // table-keyed FIFO state as the direct-db mock.
  const tx = { execute: async () => [], select, insert };
  const transaction = async (cb: (t: typeof tx) => Promise<unknown>): Promise<unknown> => cb(tx);
  return { dbState: state, dbMock: { select, insert, transaction } };
});

vi.mock('../../../db/client.js', () => ({ db: dbMock }));

import { watchdogAlertState } from '../../../db/schema.js';
import { applyBinaryWatchdogAlert } from '../vault-watchdog-alert.js';

dbState.tableNameOf = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0]);

function queueRows(rows: unknown[]): void {
  dbState.selectQueues.set(getTableName(watchdogAlertState), [rows]);
}

beforeEach(() => {
  dbState.selectQueues.clear();
  dbState.inserts = [];
  dbState.updates = [];
});

describe('applyBinaryWatchdogAlert', () => {
  it('fires notifyActive on a false→true transition and persists alertActive=true only after confirmed delivery', async () => {
    queueRows([]); // no prior row = alertActive defaults false
    const notifyActive = vi.fn(async () => true);
    const notifyRecovered = vi.fn(async () => false);

    const fired = await applyBinaryWatchdogAlert({
      watchdogName: 'test-watchdog',
      shouldBeActive: true,
      notifyActive,
      notifyRecovered,
    });

    expect(fired).toBe(true);
    expect(notifyActive).toHaveBeenCalledTimes(1);
    expect(notifyRecovered).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.set['alertActive']).toBe(true);
  });

  it('does not persist or notify when the state is unchanged (already active, should stay active)', async () => {
    queueRows([{ alertActive: true }]);
    const notifyActive = vi.fn(async () => true);
    const notifyRecovered = vi.fn(async () => true);

    const fired = await applyBinaryWatchdogAlert({
      watchdogName: 'test-watchdog',
      shouldBeActive: true,
      notifyActive,
      notifyRecovered,
    });

    expect(fired).toBe(false);
    expect(notifyActive).not.toHaveBeenCalled();
    expect(notifyRecovered).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('fires notifyRecovered on a true→false transition and persists alertActive=false', async () => {
    queueRows([{ alertActive: true }]);
    const notifyActive = vi.fn(async () => true);
    const notifyRecovered = vi.fn(async () => true);

    const fired = await applyBinaryWatchdogAlert({
      watchdogName: 'test-watchdog',
      shouldBeActive: false,
      notifyActive,
      notifyRecovered,
    });

    expect(fired).toBe(true);
    expect(notifyRecovered).toHaveBeenCalledTimes(1);
    expect(notifyActive).not.toHaveBeenCalled();
    expect(dbState.updates[0]?.set['alertActive']).toBe(false);
  });

  it('leaves state unchanged (re-arms next tick) when a due page fails to deliver', async () => {
    queueRows([]); // false→true is due
    const notifyActive = vi.fn(async () => false); // undelivered
    const notifyRecovered = vi.fn(async () => true);

    const fired = await applyBinaryWatchdogAlert({
      watchdogName: 'test-watchdog',
      shouldBeActive: true,
      notifyActive,
      notifyRecovered,
    });

    expect(fired).toBe(false);
    expect(notifyActive).toHaveBeenCalledTimes(1);
    expect(dbState.updates).toHaveLength(0); // never persisted — next tick retries
  });
});
