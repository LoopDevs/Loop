import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, dbMock } = vi.hoisted(() => {
  const s: { selectResult: unknown[] } = { selectResult: [] };
  const m: Record<string, unknown> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => s.selectResult);
  return { state: s, dbMock: m };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: { userId: 'user_id', paymentMethod: 'payment_method', id: 'id' },
}));

import { isFirstLoopAssetOrder } from '../loop-create-checks.js';

beforeEach(() => {
  state.selectResult = [];
});

describe('isFirstLoopAssetOrder', () => {
  it('returns true when the user has zero prior loop_asset orders', async () => {
    state.selectResult = [];
    expect(await isFirstLoopAssetOrder('u-1')).toBe(true);
  });

  it('returns false once the user has at least one loop_asset order', async () => {
    state.selectResult = [{ id: 'order-uuid-1' }];
    expect(await isFirstLoopAssetOrder('u-1')).toBe(false);
  });
});
