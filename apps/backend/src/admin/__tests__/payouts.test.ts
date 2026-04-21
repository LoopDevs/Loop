import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../db/schema.js', () => ({
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'] as const,
}));

const listMock = vi.fn();
vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForAdmin: (opts: unknown) => listMock(opts),
}));

import { adminListPayoutsHandler } from '../payouts.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
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
