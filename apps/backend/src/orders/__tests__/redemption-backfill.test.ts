import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// fetchRedemption is the unit under the sweeper — fully mocked here;
// its own fetch/parse behaviour is covered by redemption.test.ts.
const { fetchRedemptionMock } = vi.hoisted(() => ({ fetchRedemptionMock: vi.fn() }));
vi.mock('../procurement-redemption.js', () => ({
  fetchRedemption: (ctxOrderId: string) => fetchRedemptionMock(ctxOrderId),
}));

const { notifyExhaustedMock } = vi.hoisted(() => ({ notifyExhaustedMock: vi.fn() }));
vi.mock('../../discord.js', () => ({
  notifyRedemptionBackfillExhausted: (args: unknown) => notifyExhaustedMock(args),
}));

vi.mock('../../ctx/operator-pool.js', () => {
  class OperatorPoolUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'OperatorPoolUnavailableError';
    }
  }
  return { OperatorPoolUnavailableError };
});

// db mock — select chain resolves the stashed candidate rows; update
// chain records every `.set(...)` payload and resolves a configurable
// returning() result (default: one row, i.e. the UPDATE matched).
const { dbMock, dbState } = vi.hoisted(() => {
  const s = {
    rows: [] as unknown[],
    updates: [] as Array<Record<string, unknown>>,
    updateMatches: true,
    lastSet: null as Record<string, unknown> | null,
  };
  const selectChain: Record<string, unknown> = {};
  selectChain['from'] = vi.fn(() => selectChain);
  selectChain['where'] = vi.fn(() => selectChain);
  selectChain['orderBy'] = vi.fn(() => selectChain);
  selectChain['limit'] = vi.fn(async () => s.rows);
  const updateChain: Record<string, unknown> = {};
  updateChain['set'] = vi.fn((vals: Record<string, unknown>) => {
    s.lastSet = vals;
    return updateChain;
  });
  updateChain['where'] = vi.fn(() => updateChain);
  updateChain['returning'] = vi.fn(async () => {
    if (s.lastSet !== null) s.updates.push(s.lastSet);
    s.lastSet = null;
    return s.updateMatches ? [{ id: 'updated' }] : [];
  });
  const m = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };
  return { dbMock: m, dbState: s };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));

import { OperatorPoolUnavailableError } from '../../ctx/operator-pool.js';
import {
  runRedemptionBackfillTick,
  redemptionBackfillDelayMs,
  REDEMPTION_BACKFILL_MAX_ATTEMPTS,
} from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;

function makeRow(
  overrides: Partial<{
    id: string;
    userId: string;
    merchantId: string;
    ctxOrderId: string | null;
    fulfilledAt: Date | null;
    attempts: number;
    lastAttemptAt: Date | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: 'order-1',
    userId: 'user-1',
    merchantId: 'merchant-1',
    ctxOrderId: 'ctx-1',
    fulfilledAt: new Date(NOW - 60 * 60 * 1000),
    attempts: 0,
    lastAttemptAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchRedemptionMock.mockReset();
  notifyExhaustedMock.mockReset();
  dbState.rows = [];
  dbState.updates = [];
  dbState.updateMatches = true;
  dbState.lastSet = null;
});

describe('redemptionBackfillDelayMs', () => {
  it('grows exponentially from the 1-minute base', () => {
    expect(redemptionBackfillDelayMs(0)).toBe(60_000);
    expect(redemptionBackfillDelayMs(1)).toBe(120_000);
    expect(redemptionBackfillDelayMs(3)).toBe(480_000);
  });

  it('caps at 8 hours', () => {
    expect(redemptionBackfillDelayMs(9)).toBe(8 * 60 * 60 * 1000);
    expect(redemptionBackfillDelayMs(30)).toBe(8 * 60 * 60 * 1000);
  });
});

describe('runRedemptionBackfillTick', () => {
  it('recovers redemption fields and persists them', async () => {
    dbState.rows = [makeRow()];
    fetchRedemptionMock.mockResolvedValueOnce({ code: 'C-123', pin: '99', url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.recovered).toBe(1);
    expect(r.stillEmpty).toBe(0);
    expect(fetchRedemptionMock).toHaveBeenCalledWith('ctx-1');
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      redeemCode: 'C-123',
      redeemPin: '99',
      redeemUrl: null,
      redemptionBackfillAttempts: 1,
    });
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('still-empty payload bumps attempts + last-attempt timestamp only', async () => {
    dbState.rows = [makeRow({ attempts: 2 })];
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.stillEmpty).toBe(1);
    expect(r.recovered).toBe(0);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({ redemptionBackfillAttempts: 3 });
    expect(dbState.updates[0]).not.toHaveProperty('redeemCode');
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('skips rows whose backoff window has not elapsed', async () => {
    // attempts=3 → next attempt due 8 min after the last; only 1 min
    // has passed.
    dbState.rows = [makeRow({ attempts: 3, lastAttemptAt: new Date(NOW - 60_000) })];
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.notDueYet).toBe(1);
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('re-fetches once the backoff window has elapsed', async () => {
    dbState.rows = [makeRow({ attempts: 3, lastAttemptAt: new Date(NOW - 9 * 60_000) })];
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: 'https://r.example' });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.recovered).toBe(1);
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(1);
  });

  it('pages ops exactly once when an order exhausts the attempts cap still empty', async () => {
    dbState.rows = [
      makeRow({
        attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(NOW - 24 * 60 * 60 * 1000),
      }),
    ];
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.exhausted).toBe(1);
    expect(notifyExhaustedMock).toHaveBeenCalledTimes(1);
    expect(notifyExhaustedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        userId: 'user-1',
        merchantId: 'merchant-1',
        ctxOrderId: 'ctx-1',
        attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS,
      }),
    );
  });

  it('does not page when the attempts-bump UPDATE loses the race', async () => {
    dbState.rows = [
      makeRow({
        attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(NOW - 24 * 60 * 60 * 1000),
      }),
    ];
    dbState.updateMatches = false; // concurrent writer owns the bump
    fetchRedemptionMock.mockResolvedValueOnce({ code: null, pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.exhausted).toBe(0);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('aborts the tick on pool-wide operator outage without burning attempts', async () => {
    dbState.rows = [makeRow({ id: 'order-1' }), makeRow({ id: 'order-2', ctxOrderId: 'ctx-2' })];
    fetchRedemptionMock.mockRejectedValueOnce(new OperatorPoolUnavailableError('pool down'));
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.abortedPoolUnavailable).toBe(true);
    // First row aborted the loop — second row never fetched, no
    // attempts consumed for either.
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(1);
    expect(dbState.updates).toHaveLength(0);
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('a non-pool fetch error records the attempt and continues to the next row', async () => {
    dbState.rows = [makeRow({ id: 'order-1' }), makeRow({ id: 'order-2', ctxOrderId: 'ctx-2' })];
    fetchRedemptionMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ code: 'C-2', pin: null, url: null });
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r.errors).toBe(1);
    expect(r.recovered).toBe(1);
    expect(fetchRedemptionMock).toHaveBeenCalledTimes(2);
    // Two updates: attempts-bump for order-1, recovery for order-2.
    expect(dbState.updates).toHaveLength(2);
    expect(dbState.updates[0]).toMatchObject({ redemptionBackfillAttempts: 1 });
    expect(dbState.updates[1]).toMatchObject({ redeemCode: 'C-2' });
  });

  it('returns all-zero counters when no candidate rows exist', async () => {
    const r = await runRedemptionBackfillTick({ now: NOW });
    expect(r).toEqual({
      picked: 0,
      notDueYet: 0,
      recovered: 0,
      stillEmpty: 0,
      exhausted: 0,
      errors: 0,
      abortedPoolUnavailable: false,
    });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });
});
