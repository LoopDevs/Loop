import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, dbMock } = vi.hoisted(() => {
  const s: { selectResult: unknown[] } = { selectResult: [] };
  const m: Record<string, unknown> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(() => m);
  m['limit'] = vi.fn(async () => s.selectResult);
  // sufficient-credit chain awaits straight after where() — make the
  // chain thenable so the un-limited query path resolves to selectResult.
  (m as { then: (resolve: (v: unknown) => void) => void }).then = (resolve: (v: unknown) => void) =>
    resolve(s.selectResult);
  return { state: s, dbMock: m };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  userCredits: { userId: 'user_id', currency: 'currency', balanceMinor: 'balance_minor' },
  orders: { userId: 'user_id', paymentMethod: 'payment_method', id: 'id' },
}));

import { hasSufficientCredit, isFirstLoopAssetOrder } from '../loop-create-checks.js';

beforeEach(() => {
  state.selectResult = [];
});

describe('hasSufficientCredit', () => {
  it('returns true when the balance equals the amount', async () => {
    state.selectResult = [{ balance: '1000' }];
    expect(await hasSufficientCredit('u-1', 'USD', 1000n)).toBe(true);
  });

  it('returns true when the balance exceeds the amount', async () => {
    state.selectResult = [{ balance: '5000' }];
    expect(await hasSufficientCredit('u-1', 'USD', 1000n)).toBe(true);
  });

  it('returns false when the balance is short', async () => {
    state.selectResult = [{ balance: '500' }];
    expect(await hasSufficientCredit('u-1', 'USD', 1000n)).toBe(false);
  });

  it('treats no row as balance=0 (user has never held credit in this currency)', async () => {
    state.selectResult = [];
    expect(await hasSufficientCredit('u-1', 'USD', 1n)).toBe(false);
    expect(await hasSufficientCredit('u-1', 'USD', 0n)).toBe(true);
  });

  it('handles bigint balances larger than Number.MAX_SAFE_INTEGER without precision loss', async () => {
    state.selectResult = [{ balance: '99999999999999999999' }]; // way past JS-number range
    expect(await hasSufficientCredit('u-1', 'USD', 1n)).toBe(true);
    expect(await hasSufficientCredit('u-1', 'USD', 99_999_999_999_999_999_999n)).toBe(true);
  });
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
