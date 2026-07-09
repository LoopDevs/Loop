import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HorizonModule from '../horizon.js';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const listPaymentsMock = vi.fn();
const { sweepExpiredOrdersMock, advisoryState } = vi.hoisted(() => ({
  sweepExpiredOrdersMock: vi.fn<(cutoff: Date) => Promise<number>>(async () => 0),
  advisoryState: { acquired: true },
}));

vi.mock('../horizon.js', async () => {
  const actual = await vi.importActual<typeof HorizonModule>('../horizon.js');
  return {
    ...actual,
    listAccountPayments: (args: unknown) => listPaymentsMock(args),
  };
});
vi.mock('../../orders/repo.js', () => ({
  findPendingOrderByMemo: async () => null,
}));
vi.mock('../../orders/transitions.js', () => ({
  markOrderPaid: async () => null,
  sweepExpiredOrders: (cutoff: Date) => sweepExpiredOrdersMock(cutoff),
}));

const { dbMock } = vi.hoisted(() => {
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn(() => m);
  m['onConflictDoUpdate'] = vi.fn(async () => undefined);
  return { dbMock: m };
});

vi.mock('../../db/client.js', () => ({
  db: {
    insert: dbMock['insert'],
    query: {
      watcherCursors: {
        findFirst: vi.fn(async () => undefined),
      },
    },
  },
  // S4-8: withAdvisoryLock mock — same shape as interest-mint.test.ts.
  // Default acquires the lock and runs `fn`; `advisoryState.acquired
  // = false` simulates another machine holding it fleet-wide.
  withAdvisoryLock: async <T>(
    _lockKey: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (!advisoryState.acquired) return { ran: false };
    return { ran: true, value: await fn() };
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    watcherCursors: { name: 'name', cursor: 'cursor', updatedAt: 'updatedAt' },
  };
});

import { startPaymentWatcher, stopPaymentWatcher } from '../watcher.js';
import { runOrderExpirySweepTick } from '../watcher-bootstrap.js';

const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGV';

beforeEach(() => {
  listPaymentsMock.mockReset();
  listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
  sweepExpiredOrdersMock.mockReset();
  sweepExpiredOrdersMock.mockResolvedValue(0);
  advisoryState.acquired = true;
  vi.useFakeTimers();
});

afterEach(() => {
  stopPaymentWatcher();
  vi.useRealTimers();
});

describe('startPaymentWatcher / stopPaymentWatcher', () => {
  it('runs an immediate tick on start', async () => {
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 10_000 });
    // Flush pending microtasks (the immediate void tick()).
    await vi.advanceTimersByTimeAsync(0);
    expect(listPaymentsMock).toHaveBeenCalledTimes(1);
  });

  it('ticks again after the interval elapses', async () => {
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listPaymentsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listPaymentsMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listPaymentsMock).toHaveBeenCalledTimes(3);
  });

  it('is idempotent — a second start while already running is a no-op', async () => {
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    // Two starts → still one immediate kick-off (first call won).
    expect(listPaymentsMock).toHaveBeenCalledTimes(1);
  });

  it('stop prevents further ticks', async () => {
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    stopPaymentWatcher();
    await vi.advanceTimersByTimeAsync(20_000);
    // Only the immediate kick-off counted; the interval never fired.
    expect(listPaymentsMock).toHaveBeenCalledTimes(1);
  });

  it('survives a tick that throws — next tick still fires', async () => {
    listPaymentsMock
      .mockRejectedValueOnce(new Error('horizon down'))
      .mockResolvedValue({ records: [], nextCursor: null });
    startPaymentWatcher({ account: ACCOUNT, intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listPaymentsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listPaymentsMock).toHaveBeenCalledTimes(2);
  });
});

describe('runOrderExpirySweepTick (S4-8)', () => {
  it('runs the sweep and reports the swept count when it wins the lock', async () => {
    sweepExpiredOrdersMock.mockResolvedValue(3);
    const r = await runOrderExpirySweepTick();
    expect(r).toEqual({ swept: 3, skippedLocked: false });
    expect(sweepExpiredOrdersMock).toHaveBeenCalledTimes(1);
  });

  it('skips the sweep when another machine holds the expiry-sweep lock', async () => {
    advisoryState.acquired = false;
    const r = await runOrderExpirySweepTick();
    expect(r).toEqual({ swept: 0, skippedLocked: true });
    expect(sweepExpiredOrdersMock).not.toHaveBeenCalled();
  });

  it('releases the lock + returns empty when the sweep exceeds the lease deadline', async () => {
    // A hung DB UPDATE: sweepExpiredOrders never resolves. The lease
    // must fire so the fleet-wide lock is released.
    let releaseHang: () => void = () => {};
    sweepExpiredOrdersMock.mockReturnValue(
      new Promise((resolve) => {
        releaseHang = () => resolve(0);
      }),
    );
    const tickPromise = runOrderExpirySweepTick();
    // Advance past the 60s lease — the Promise.race timeout wins.
    await vi.advanceTimersByTimeAsync(60_001);
    const r = await tickPromise;
    expect(r).toEqual({ swept: 0, skippedLocked: false });
    releaseHang();
  });
});
