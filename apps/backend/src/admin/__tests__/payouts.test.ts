import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../db/schema.js', () => ({
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'] as const,
  pendingPayouts: {
    state: 'state',
    createdAt: 'created_at',
    amountStroops: 'amount_stroops',
  },
}));

const listMock = vi.fn();
const resetMock = vi.fn();
vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForAdmin: (opts: unknown) => listMock(opts),
  resetPayoutToPending: (id: string) => resetMock(id),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[], throw: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));

import {
  adminListPayoutsHandler,
  adminPayoutsSummaryHandler,
  adminRetryPayoutHandler,
} from '../payouts.js';

function makeCtx(query: Record<string, string> = {}, params: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const baseRow = {
  id: 'p-1',
  userId: 'u-1',
  orderId: 'o-1',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GDESTINATION',
  amountStroops: 50_000_000n,
  memoText: 'o-1',
  state: 'pending',
  txHash: null,
  lastError: null,
  attempts: 0,
  createdAt: new Date('2026-04-21T12:00:00Z'),
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
};

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([baseRow]);
  resetMock.mockReset();
  execState.rows = [];
  execState.throw = false;
});

describe('adminListPayoutsHandler', () => {
  it('returns the BigInt-safe view for a simple list', async () => {
    const res = await adminListPayoutsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0]).toMatchObject({
      id: 'p-1',
      amountStroops: '50000000',
      createdAt: '2026-04-21T12:00:00.000Z',
    });
  });

  it('filters by ?state=failed when a valid state is given', async () => {
    await adminListPayoutsHandler(makeCtx({ state: 'failed' }));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
  });

  it('400 when ?state is not in the enum', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ state: 'rogue' }));
    expect(res.status).toBe(400);
  });

  it('defaults limit to 20 and clamps to 1..100', async () => {
    await adminListPayoutsHandler(makeCtx());
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));

    await adminListPayoutsHandler(makeCtx({ limit: '0' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));

    await adminListPayoutsHandler(makeCtx({ limit: '999' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));

    await adminListPayoutsHandler(makeCtx({ limit: 'not-a-number' }));
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('accepts a well-formed before= timestamp', async () => {
    await adminListPayoutsHandler(makeCtx({ before: '2026-04-21T00:00:00Z' }));
    const call = listMock.mock.calls[0]![0] as { before?: Date };
    expect(call.before).toBeInstanceOf(Date);
    expect(call.before!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
  });

  it('400 on malformed before= timestamp', async () => {
    const res = await adminListPayoutsHandler(makeCtx({ before: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('serialises nullable timestamps as null, populated as ISO strings', async () => {
    listMock.mockResolvedValue([
      {
        ...baseRow,
        state: 'confirmed',
        submittedAt: new Date('2026-04-21T13:00:00Z'),
        confirmedAt: new Date('2026-04-21T13:05:00Z'),
        txHash: 'abc',
      },
    ]);
    const res = await adminListPayoutsHandler(makeCtx());
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body.payouts[0]!['submittedAt']).toBe('2026-04-21T13:00:00.000Z');
    expect(body.payouts[0]!['confirmedAt']).toBe('2026-04-21T13:05:00.000Z');
    expect(body.payouts[0]!['failedAt']).toBeNull();
    expect(body.payouts[0]!['txHash']).toBe('abc');
  });
});

describe('adminRetryPayoutHandler', () => {
  it('400 when id param is missing', async () => {
    const res = await adminRetryPayoutHandler(makeCtx({}, {}));
    expect(res.status).toBe(400);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('resets the payout to pending and returns the updated view', async () => {
    resetMock.mockResolvedValue({ ...baseRow, state: 'pending', lastError: null });
    const res = await adminRetryPayoutHandler(makeCtx({}, { id: 'p-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe('p-1');
    expect(body['state']).toBe('pending');
    expect(resetMock).toHaveBeenCalledWith('p-1');
  });

  it('404 when the row is not in failed state (or doesnt exist)', async () => {
    resetMock.mockResolvedValue(null);
    const res = await adminRetryPayoutHandler(makeCtx({}, { id: 'p-1' }));
    expect(res.status).toBe(404);
  });

  it('500 when the repo throws', async () => {
    resetMock.mockRejectedValue(new Error('db exploded'));
    const res = await adminRetryPayoutHandler(makeCtx({}, { id: 'p-1' }));
    expect(res.status).toBe(500);
  });
});

describe('adminPayoutsSummaryHandler', () => {
  it('rolls counts, zero-fills missing states, echoes oldest + total stroops', async () => {
    execState.rows = [
      {
        state: 'pending',
        n: 3,
        oldest: new Date('2026-04-20T09:00:00Z'),
        totalStroops: 150_000_000n,
      },
      {
        state: 'submitted',
        n: 1,
        oldest: new Date('2026-04-21T11:00:00Z'),
        totalStroops: 50_000_000n,
      },
      {
        state: 'confirmed',
        n: 42,
        oldest: new Date('2026-04-01T00:00:00Z'),
        totalStroops: 2_000_000_000n,
      },
    ];
    const res = await adminPayoutsSummaryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      oldestPendingAt: string | null;
      oldestSubmittedAt: string | null;
      pendingStroops: string;
    };
    expect(body.counts).toEqual({ pending: 3, submitted: 1, confirmed: 42, failed: 0 });
    expect(body.oldestPendingAt).toBe('2026-04-20T09:00:00.000Z');
    expect(body.oldestSubmittedAt).toBe('2026-04-21T11:00:00.000Z');
    expect(body.pendingStroops).toBe('150000000');
  });

  it('returns all-zeros + null timestamps on an empty table', async () => {
    execState.rows = [];
    const res = await adminPayoutsSummaryHandler(makeCtx());
    const body = (await res.json()) as {
      counts: Record<string, number>;
      oldestPendingAt: string | null;
      oldestSubmittedAt: string | null;
      pendingStroops: string;
    };
    expect(body.counts).toEqual({ pending: 0, submitted: 0, confirmed: 0, failed: 0 });
    expect(body.oldestPendingAt).toBeNull();
    expect(body.oldestSubmittedAt).toBeNull();
    expect(body.pendingStroops).toBe('0');
  });

  it('handles ISO-string oldest values (some pg drivers skip Date coercion)', async () => {
    execState.rows = [
      {
        state: 'pending',
        n: 1,
        oldest: '2026-04-20T09:00:00Z',
        totalStroops: 1000n,
      },
    ];
    const res = await adminPayoutsSummaryHandler(makeCtx());
    const body = (await res.json()) as { oldestPendingAt: string | null };
    expect(body.oldestPendingAt).toBe('2026-04-20T09:00:00.000Z');
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [
        {
          state: 'failed',
          n: 2,
          oldest: new Date('2026-04-10T00:00:00Z'),
          totalStroops: 0n,
        },
      ],
    } as unknown as unknown[];
    const res = await adminPayoutsSummaryHandler(makeCtx());
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts.failed).toBe(2);
  });

  it('ignores unknown state values', async () => {
    execState.rows = [
      {
        state: 'ghost',
        n: 99,
        oldest: new Date('2026-04-20T09:00:00Z'),
        totalStroops: 0n,
      },
    ];
    const res = await adminPayoutsSummaryHandler(makeCtx());
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminPayoutsSummaryHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
