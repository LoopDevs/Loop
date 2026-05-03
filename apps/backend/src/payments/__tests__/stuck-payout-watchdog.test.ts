import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, notifyMock } = vi.hoisted(() => ({
  listMock: vi.fn<(args?: { thresholdMinutes?: number; limit?: number }) => Promise<unknown[]>>(
    async () => [],
  ),
  notifyMock: vi.fn<(args: unknown) => void>(() => undefined),
}));

vi.mock('../../admin/stuck-payouts.js', () => ({
  listStuckPayoutRows: (args?: { thresholdMinutes?: number; limit?: number }) => listMock(args),
}));

vi.mock('../../discord.js', () => ({
  notifyStuckPayouts: (args: unknown) => notifyMock(args),
}));

import {
  __resetStuckPayoutWatchdogForTests,
  runStuckPayoutWatchdog,
} from '../stuck-payout-watchdog.js';

beforeEach(() => {
  listMock.mockReset();
  notifyMock.mockReset();
  listMock.mockResolvedValue([]);
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
});
