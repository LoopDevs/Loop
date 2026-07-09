import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state, mocks } = vi.hoisted(() => ({
  state: {
    row: undefined as { cursor: string | null; updatedAt: Date } | undefined,
    /** S4-8: whether the pg_try_advisory_xact_lock probe "acquires". */
    advisoryAcquired: true,
    /** Persisted watchdog_alert_state rows (name → alert_active). */
    alertState: new Map<string, boolean>(),
    /** Whether notifyPaymentWatcherStuck's send "confirms delivery". */
    notifyDelivered: true,
  },
  mocks: {
    notifyPaymentWatcherStuck: vi.fn<(args: unknown) => Promise<boolean>>(),
    txExecute: vi.fn(),
  },
}));

// S4-8: db.transaction + pg_try_advisory_xact_lock mock — same shape
// as ledger-invariant-watcher.test.ts, extended with an in-memory
// emulation of the persisted `watchdog_alert_state` row (select →
// read the map, insert().onConflictDoUpdate → upsert the map) so the
// fire-once / re-arm / at-least-once contract is exercised for real.
vi.mock('../../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mocks.txExecute.mockImplementation(async () => [
          { locked: state.advisoryAcquired },
        ]),
        query: {
          watcherCursors: {
            findFirst: vi.fn(async () => state.row),
          },
        },
        select: () => ({
          from: () => ({
            where: async () => {
              const active = state.alertState.get('cursor-watchdog');
              return active === undefined ? [] : [{ alertActive: active }];
            },
          }),
        }),
        insert: () => ({
          values: (vals: { watchdogName: string; alertActive: boolean }) => ({
            onConflictDoUpdate: async () => {
              state.alertState.set(vals.watchdogName, vals.alertActive);
            },
          }),
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock('../../db/schema.js', () => ({
  watcherCursors: { name: 'name', cursor: 'cursor', updatedAt: 'updated_at' },
  watchdogAlertState: {
    watchdogName: 'watchdog_name',
    alertActive: 'alert_active',
    updatedAt: 'updated_at',
  },
}));

vi.mock('../../discord.js', () => ({
  notifyPaymentWatcherStuck: (args: unknown) => mocks.notifyPaymentWatcherStuck(args),
}));

import { runCursorWatchdog } from '../cursor-watchdog.js';

const STALE = (): { cursor: string; updatedAt: Date } => ({
  cursor: 'pt-1',
  updatedAt: new Date(Date.now() - 11 * 60 * 1000),
});

beforeEach(() => {
  state.row = undefined;
  state.advisoryAcquired = true;
  state.alertState = new Map();
  state.notifyDelivered = true;
  mocks.notifyPaymentWatcherStuck.mockReset();
  mocks.notifyPaymentWatcherStuck.mockImplementation(async () => state.notifyDelivered);
  mocks.txExecute.mockClear();
});

describe('runCursorWatchdog', () => {
  it('no-ops silently when the cursor row does not yet exist (cold deploy)', async () => {
    state.row = undefined;
    const r = await runCursorWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: false });
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
    expect(state.alertState.size).toBe(0);
  });

  it('does not page when cursor age is below the stale threshold', async () => {
    state.row = { cursor: 'pt-1', updatedAt: new Date(Date.now() - 60_000) }; // 1 min old
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
  });

  it('pages once on the first stale tick (>10 min) and persists alert_active', async () => {
    state.row = STALE();
    const r = await runCursorWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: true });
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
    const args = mocks.notifyPaymentWatcherStuck.mock.calls[0]![0] as {
      cursorAgeMs: number;
      lastCursor: string;
      lastUpdatedAtMs: number;
    };
    expect(args.lastCursor).toBe('pt-1');
    expect(args.cursorAgeMs).toBeGreaterThan(10 * 60 * 1000);
    expect(state.alertState.get('cursor-watchdog')).toBe(true);
  });

  it('does not re-page during the same stuck period (persisted fleet-wide gate)', async () => {
    state.row = STALE();
    await runCursorWatchdog();
    await runCursorWatchdog();
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
  });

  it('S4-8 P0 regression: a stale active=true row from a PAST incident re-arms on a healthy tick, and the NEXT incident pages exactly once fleet-wide', async () => {
    // Simulate the pre-fix hazard: the persisted state says an alert
    // fired in a past incident (with the old per-process boolean this
    // was a machine whose local gate latched true and would silently
    // skip paging forever).
    state.alertState.set('cursor-watchdog', true);

    // Healthy tick → the lock holder re-arms the persisted state.
    state.row = { cursor: 'pt-2', updatedAt: new Date() };
    await runCursorWatchdog();
    expect(state.alertState.get('cursor-watchdog')).toBe(false);
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();

    // A NEW incident: pages exactly once regardless of which machine
    // wins the lock — the gate is in the DB, not process memory.
    state.row = { cursor: 'pt-2', updatedAt: new Date(Date.now() - 11 * 60 * 1000) };
    await runCursorWatchdog();
    await runCursorWatchdog();
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
    expect(state.alertState.get('cursor-watchdog')).toBe(true);
  });

  it('S4-8 at-least-once: a failed webhook send leaves the state unfired so the next tick retries the page', async () => {
    state.row = STALE();
    state.notifyDelivered = false;

    const r1 = await runCursorWatchdog();
    expect(r1).toEqual({ skippedLocked: false, notified: false });
    // Send attempted but NOT confirmed → gate must stay unfired.
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(1);
    expect(state.alertState.get('cursor-watchdog') ?? false).toBe(false);

    // Discord recovers → the next tick re-attempts and then latches.
    state.notifyDelivered = true;
    const r2 = await runCursorWatchdog();
    expect(r2).toEqual({ skippedLocked: false, notified: true });
    expect(mocks.notifyPaymentWatcherStuck).toHaveBeenCalledTimes(2);
    expect(state.alertState.get('cursor-watchdog')).toBe(true);
  });

  it('passes empty string when last cursor is null (typed safely)', async () => {
    state.row = { cursor: null, updatedAt: new Date(Date.now() - 11 * 60 * 1000) };
    await runCursorWatchdog();
    const args = mocks.notifyPaymentWatcherStuck.mock.calls[0]![0] as { lastCursor: string };
    expect(args.lastCursor).toBe('');
  });

  it('S4-8: skips the check when another machine holds the cursor-watchdog lock', async () => {
    state.advisoryAcquired = false;
    state.row = STALE();
    const r = await runCursorWatchdog();
    expect(r).toEqual({ skippedLocked: true, notified: false });
    expect(mocks.notifyPaymentWatcherStuck).not.toHaveBeenCalled();
    expect(state.alertState.size).toBe(0);
  });
});
