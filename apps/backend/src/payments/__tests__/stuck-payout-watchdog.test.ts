import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, notifyMock, state, mocks } = vi.hoisted(() => ({
  listMock: vi.fn<(args?: { thresholdMinutes?: number; limit?: number }) => Promise<unknown[]>>(
    async () => [],
  ),
  notifyMock: vi.fn<(args: unknown) => void>(() => undefined),
  state: {
    /** S4-8: whether the pg_try_advisory_xact_lock probe "acquires". */
    advisoryAcquired: true,
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

// S4-8: db.transaction + pg_try_advisory_xact_lock mock — same shape
// as ledger-invariant-watcher.test.ts / cursor-watchdog.test.ts.
vi.mock('../../db/client.js', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: mocks.txExecute.mockImplementation(async () => [
          { locked: state.advisoryAcquired },
        ]),
      };
      return fn(tx);
    },
  },
}));

import {
  __resetStuckPayoutWatchdogForTests,
  runStuckPayoutWatchdog,
} from '../stuck-payout-watchdog.js';

beforeEach(() => {
  listMock.mockReset();
  notifyMock.mockReset();
  listMock.mockResolvedValue([]);
  state.advisoryAcquired = true;
  mocks.txExecute.mockClear();
  __resetStuckPayoutWatchdogForTests();
});

describe('runStuckPayoutWatchdog', () => {
  it('does not notify when there are no stuck rows', async () => {
    await runStuckPayoutWatchdog();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('notifies once per stuck period and resets after recovery', async () => {
    listMock.mockResolvedValue([
      {
        id: 'p-1',
        assetCode: 'USDLOOP',
        state: 'submitted',
        ageMinutes: 11,
      },
      {
        id: 'p-2',
        assetCode: 'USDLOOP',
        state: 'pending',
        ageMinutes: 8,
      },
    ]);

    await runStuckPayoutWatchdog({ thresholdMinutes: 5, limit: 10 });
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

    listMock.mockResolvedValue([]);
    await runStuckPayoutWatchdog();

    listMock.mockResolvedValue([
      {
        id: 'p-3',
        assetCode: 'GBPLOOP',
        state: 'pending',
        ageMinutes: 7,
      },
    ]);
    await runStuckPayoutWatchdog();
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it('S4-8: skips the check when another machine holds the stuck-payout-watchdog lock', async () => {
    state.advisoryAcquired = false;
    listMock.mockResolvedValue([
      { id: 'p-1', assetCode: 'USDLOOP', state: 'submitted', ageMinutes: 11 },
    ]);
    const r = await runStuckPayoutWatchdog({ thresholdMinutes: 5, limit: 10 });
    expect(r).toEqual({ skippedLocked: true });
    expect(listMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('returns skippedLocked: false when it acquires the lock and runs', async () => {
    const r = await runStuckPayoutWatchdog();
    expect(r).toEqual({ skippedLocked: false });
  });
});
