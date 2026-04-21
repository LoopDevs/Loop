import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock('../../upstream.js', () => ({
  upstreamUrl: (path: string) => `https://ctx.example${path}`,
}));
vi.mock('../transitions.js', () => ({
  markOrderProcuring: async () => null,
  markOrderFulfilled: async () => null,
  markOrderFailed: async () => null,
}));
vi.mock('../../ctx/operator-pool.js', () => ({
  operatorFetch: async () => new Response('{}', { status: 200 }),
  OperatorPoolUnavailableError: class extends Error {},
}));

const limitMock = vi.fn();

const { dbMock } = vi.hoisted(() => {
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['orderBy'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => []);
  return { dbMock: m };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: { state: 'state', paidAt: 'paid_at' },
  };
});

import { startProcurementWorker, stopProcurementWorker } from '../procurement.js';

beforeEach(() => {
  limitMock.mockReset();
  // dbMock.limit is awaited in runProcurementTick; route it through
  // our spy so we can count invocations.
  dbMock['limit']!.mockImplementation(async () => {
    limitMock();
    return [];
  });
  vi.useFakeTimers();
});

afterEach(() => {
  stopProcurementWorker();
  vi.useRealTimers();
});

describe('startProcurementWorker / stopProcurementWorker', () => {
  it('runs an immediate tick on start', async () => {
    startProcurementWorker({ intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('ticks on the configured interval', async () => {
    startProcurementWorker({ intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(limitMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(limitMock).toHaveBeenCalledTimes(4);
  });

  it('double-start is a no-op', async () => {
    startProcurementWorker({ intervalMs: 5_000 });
    startProcurementWorker({ intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('stop halts the interval', async () => {
    startProcurementWorker({ intervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    stopProcurementWorker();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(limitMock).toHaveBeenCalledTimes(1);
  });
});
