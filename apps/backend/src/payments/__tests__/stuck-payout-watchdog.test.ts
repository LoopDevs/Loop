import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, notifyMock, state, mocks } = vi.hoisted(() => ({
  listMock: vi.fn<(args?: { thresholdMinutes?: number; limit?: number }) => Promise<unknown[]>>(
    async () => [],
  ),
  notifyMock: vi.fn<(args: unknown) => Promise<boolean>>(),
  state: {
    /** S4-8: whether the pg_try_advisory_xact_lock probe "acquires". */
    advisoryAcquired: true,
    /** Persisted watchdog_alert_state rows (name → alert_active). */
    alertState: new Map<string, boolean>(),
    /** Whether notifyStuckPayouts's send "confirms delivery". */
    notifyDelivered: true,
  },
  mocks: {
    txExecute: vi.fn(),
  },
}));

vi.mock('../../admin/stuck-payouts.js', () => ({
  listStuckPayoutRows: (args?: { thresholdMinutes?: number; limit?: number }) => listMock(args),
}));

vi.mock('../../discord.js', () => ({
  notifyStuckPayouts: (args: unknown) => notifyMock(args),
}));

vi.mock('../../db/schema.js', () => ({
  watchdogAlertState: {
    watchdogName: 'watchdog_name',
    alertActive: 'alert_active',
    updatedAt: 'updated_at',
  },
}));

// S4-8: db.transaction + pg_try_advisory_xact_lock mock — same shape
// as ledger-invariant-watcher.test.ts / cursor-watchdog.test.ts, with
// an in-memory emulation of the persisted `watchdog_alert_state` row
// so the fire-once / re-arm / at-least-once contract is exercised.
vi.mock('../../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mocks.txExecute.mockImplementation(async () => [
          { locked: state.advisoryAcquired },
        ]),
        select: () => ({
          from: () => ({
            where: async () => {
              const active = state.alertState.get('stuck-payout-watchdog');
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

import { runStuckPayoutWatchdog } from '../stuck-payout-watchdog.js';

const STUCK_ROWS = [
  { id: 'p-1', assetCode: 'USDLOOP', state: 'submitted', ageMinutes: 11 },
  { id: 'p-2', assetCode: 'USDLOOP', state: 'pending', ageMinutes: 8 },
];

beforeEach(() => {
  listMock.mockReset();
  notifyMock.mockReset();
  listMock.mockResolvedValue([]);
  notifyMock.mockImplementation(async () => state.notifyDelivered);
  state.advisoryAcquired = true;
  state.alertState = new Map();
  state.notifyDelivered = true;
  mocks.txExecute.mockClear();
});

describe('runStuckPayoutWatchdog', () => {
  it('does not notify when there are no stuck rows', async () => {
    const r = await runStuckPayoutWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: false });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('notifies once per stuck period (persisted gate) and resets after recovery', async () => {
    listMock.mockResolvedValue(STUCK_ROWS);

    const r1 = await runStuckPayoutWatchdog({ thresholdMinutes: 5, limit: 10 });
    expect(r1).toEqual({ skippedLocked: false, notified: true });
    await runStuckPayoutWatchdog({ thresholdMinutes: 5, limit: 10 });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rowCount: 2,
        thresholdMinutes: 5,
        oldestAgeMinutes: 11,
        pendingCount: 1,
        submittedCount: 1,
        payoutId: 'p-1',
      }),
    );
    expect(state.alertState.get('stuck-payout-watchdog')).toBe(true);

    listMock.mockResolvedValue([]);
    await runStuckPayoutWatchdog();
    expect(state.alertState.get('stuck-payout-watchdog')).toBe(false);

    listMock.mockResolvedValue([
      { id: 'p-3', assetCode: 'GBPLOOP', state: 'pending', ageMinutes: 7 },
    ]);
    await runStuckPayoutWatchdog();
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it('S4-8 P0 regression: a stale active=true row from a PAST incident re-arms on a healthy tick, and the NEXT incident pages exactly once fleet-wide', async () => {
    // Pre-fix hazard: with the per-process boolean, a machine whose
    // gate latched true during a past incident could win the lock in a
    // future, distinct incident and silently skip paging.
    state.alertState.set('stuck-payout-watchdog', true);

    // Healthy tick → the lock holder re-arms the persisted state.
    listMock.mockResolvedValue([]);
    await runStuckPayoutWatchdog();
    expect(state.alertState.get('stuck-payout-watchdog')).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();

    // A NEW incident pages exactly once regardless of which machine
    // wins the lock — the gate is in the DB, not process memory.
    listMock.mockResolvedValue(STUCK_ROWS);
    await runStuckPayoutWatchdog();
    await runStuckPayoutWatchdog();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(state.alertState.get('stuck-payout-watchdog')).toBe(true);
  });

  it('S4-8 at-least-once: a failed webhook send leaves the state unfired so the next tick retries the page', async () => {
    listMock.mockResolvedValue(STUCK_ROWS);
    state.notifyDelivered = false;

    const r1 = await runStuckPayoutWatchdog();
    expect(r1).toEqual({ skippedLocked: false, notified: false });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(state.alertState.get('stuck-payout-watchdog') ?? false).toBe(false);

    // Discord recovers → the next tick re-attempts and then latches.
    state.notifyDelivered = true;
    const r2 = await runStuckPayoutWatchdog();
    expect(r2).toEqual({ skippedLocked: false, notified: true });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(state.alertState.get('stuck-payout-watchdog')).toBe(true);
  });

  it('S4-8: skips the check when another machine holds the stuck-payout-watchdog lock', async () => {
    state.advisoryAcquired = false;
    listMock.mockResolvedValue(STUCK_ROWS);
    const r = await runStuckPayoutWatchdog({ thresholdMinutes: 5, limit: 10 });
    expect(r).toEqual({ skippedLocked: true, notified: false });
    expect(listMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(state.alertState.size).toBe(0);
  });
});
