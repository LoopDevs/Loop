import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `sumOutstandingLiability` is a single `SELECT COALESCE(SUM(...),
 * 0)` over `user_credits` filtered by currency. The mock returns
 * whatever `mockRow` is set to — a `{ total: string }` shape mirrors
 * the drizzle result row (A2-1701).
 */
const { dbMock, state } = vi.hoisted(() => {
  const s: { mockRow: { total: string } | undefined; whereClauses: unknown[] } = {
    mockRow: undefined,
    whereClauses: [],
  };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(async (clause: unknown) => {
    s.whereClauses.push(clause);
    return s.mockRow === undefined ? [] : [s.mockRow];
  });
  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  userCredits: { balanceMinor: 'balance_minor', currency: 'currency' },
}));

import { sumOutstandingLiability } from '../liabilities.js';

beforeEach(() => {
  state.mockRow = undefined;
  state.whereClauses = [];
});

describe('sumOutstandingLiability', () => {
  it('returns 0n when no user has a balance in the currency', async () => {
    state.mockRow = { total: '0' };
    expect(await sumOutstandingLiability('USD')).toBe(0n);
  });

  it('returns 0n even when the query returns no row at all', async () => {
    state.mockRow = undefined;
    expect(await sumOutstandingLiability('USD')).toBe(0n);
  });

  it('parses the COALESCE-cast string into a bigint', async () => {
    state.mockRow = { total: '125000' };
    expect(await sumOutstandingLiability('GBP')).toBe(125000n);
  });

  it('preserves precision past 2^53 — fleet liability totals do not fit in a Number', async () => {
    // 2^53 + 123 — would round-trip wrong through `Number()`.
    state.mockRow = { total: '9007199254740992123' };
    expect(await sumOutstandingLiability('USD')).toBe(9_007_199_254_740_992_123n);
  });

  it('filters by the requested currency (only one SELECT per call)', async () => {
    state.mockRow = { total: '42' };
    await sumOutstandingLiability('EUR');
    expect(state.whereClauses).toHaveLength(1);
    // The clause is a drizzle SQL template; we can't introspect the
    // rendered SQL cheaply from the mock, but its presence confirms
    // the call went through the `.where` filter step.
  });
});
