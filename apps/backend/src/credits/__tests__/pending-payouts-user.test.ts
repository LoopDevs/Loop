import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state, dbMock } = vi.hoisted(() => {
  const s: {
    selectResult: unknown;
    capturedWhere: unknown;
    capturedLimit: number | null;
    capturedOrderBy: unknown;
    capturedGroupBy: unknown;
  } = {
    selectResult: [],
    capturedWhere: null,
    capturedLimit: null,
    capturedOrderBy: null,
    capturedGroupBy: null,
  };
  const m: Record<string, unknown> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn((w: unknown) => {
    s.capturedWhere = w;
    return m;
  });
  m['orderBy'] = vi.fn((o: unknown) => {
    s.capturedOrderBy = o;
    return m;
  });
  m['groupBy'] = vi.fn((...gs: unknown[]) => {
    s.capturedGroupBy = gs;
    // For groupBy paths, awaiting returns the rows directly.
    (m as { then?: (resolve: (v: unknown) => void) => void }).then = (
      resolve: (v: unknown) => void,
    ) => resolve(s.selectResult);
    return m;
  });
  m['limit'] = vi.fn(async (n: number) => {
    s.capturedLimit = n;
    return s.selectResult;
  });
  return { state: s, dbMock: m };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    id: 'id',
    userId: 'user_id',
    orderId: 'order_id',
    state: 'state',
    assetCode: 'asset_code',
    amountStroops: 'amount_stroops',
    createdAt: 'created_at',
  },
}));

import {
  listPayoutsForUser,
  pendingPayoutsSummaryForUser,
  getPayoutForUser,
  getPayoutByOrderIdForUser,
} from '../pending-payouts-user.js';

beforeEach(() => {
  state.selectResult = [];
  state.capturedWhere = null;
  state.capturedLimit = null;
  state.capturedOrderBy = null;
  state.capturedGroupBy = null;
  // Reset thenable so list/single-row paths don't accidentally hit the groupBy thenable.
  delete (dbMock as { then?: unknown }).then;
});

describe('listPayoutsForUser', () => {
  it('clamps limit to [1,100], defaulting to 20 when omitted', async () => {
    state.selectResult = [];
    await listPayoutsForUser('u-1');
    expect(state.capturedLimit).toBe(20);
    await listPayoutsForUser('u-1', { limit: 1000 });
    expect(state.capturedLimit).toBe(100);
    await listPayoutsForUser('u-1', { limit: 0 });
    expect(state.capturedLimit).toBe(1);
    await listPayoutsForUser('u-1', { limit: 50 });
    expect(state.capturedLimit).toBe(50);
  });

  it('returns the rows the chain resolves with', async () => {
    state.selectResult = [{ id: 'p-1', userId: 'u-1' }];
    const out = await listPayoutsForUser('u-1');
    expect(out).toEqual([{ id: 'p-1', userId: 'u-1' }]);
  });
});

describe('pendingPayoutsSummaryForUser', () => {
  it('coerces count + totalStroops strings into number/bigint', async () => {
    state.selectResult = [
      {
        assetCode: 'USDLOOP',
        state: 'pending',
        count: '3',
        totalStroops: '1500000',
        oldestCreatedAt: new Date('2026-04-01T12:00:00Z'),
      },
    ];
    const out = await pendingPayoutsSummaryForUser('u-1');
    expect(out).toEqual([
      {
        assetCode: 'USDLOOP',
        state: 'pending',
        count: 3,
        totalStroops: 1_500_000n,
        oldestCreatedAtMs: new Date('2026-04-01T12:00:00Z').getTime(),
      },
    ]);
  });

  it('returns an empty array when the user has no in-flight payouts', async () => {
    state.selectResult = [];
    const out = await pendingPayoutsSummaryForUser('u-empty');
    expect(out).toEqual([]);
  });
});

describe('getPayoutForUser', () => {
  it('returns the row when (id, userId) matches', async () => {
    state.selectResult = [{ id: 'p-1', userId: 'u-1' }];
    const out = await getPayoutForUser('p-1', 'u-1');
    expect(out).toEqual({ id: 'p-1', userId: 'u-1' });
  });

  it('returns null when no row matches (handler converts to 404)', async () => {
    state.selectResult = [];
    const out = await getPayoutForUser('p-missing', 'u-1');
    expect(out).toBeNull();
  });
});

describe('getPayoutByOrderIdForUser', () => {
  it('returns the row when (orderId, userId) matches', async () => {
    state.selectResult = [{ id: 'p-1', orderId: 'o-1', userId: 'u-1' }];
    const out = await getPayoutByOrderIdForUser('o-1', 'u-1');
    expect(out?.id).toBe('p-1');
  });

  it('returns null when the order belongs to a different user — does not leak existence', async () => {
    state.selectResult = [];
    const out = await getPayoutByOrderIdForUser('o-belonging-to-someone-else', 'u-1');
    expect(out).toBeNull();
  });
});
