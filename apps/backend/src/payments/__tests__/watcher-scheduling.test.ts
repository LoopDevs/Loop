import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HorizonModule from '../horizon.js';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const listPaymentsMock = vi.fn();

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
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    watcherCursors: { name: 'name', cursor: 'cursor', updatedAt: 'updatedAt' },
  };
});

import { startPaymentWatcher, stopPaymentWatcher } from '../watcher.js';

const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGV';

beforeEach(() => {
  listPaymentsMock.mockReset();
  listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
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
