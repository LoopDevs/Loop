/**
 * refetchOrderRedemption (ADR 037) — the one-shot admin re-drive
 * through the backfill machinery. Sibling of
 * redemption-backfill.test.ts (which covers the sweeper tick);
 * this covers the per-order eligibility gates, the no-cap /
 * no-backoff contract, and the attempt bookkeeping shared with the
 * sweeper.
 */
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

// db mock — awaiting the select chain resolves the stashed row;
// update chain records `.set()` payloads, resolves a configurable
// returning().
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
  selectChain['then'] = (resolve: (rows: unknown[]) => void) => Promise.resolve(resolve(s.rows));
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
  refetchOrderRedemption,
  REDEMPTION_BACKFILL_MAX_ATTEMPTS,
} from '../redemption-backfill.js';

const NOW = 1_900_000_000_000;
const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    userId: 'user-1',
    merchantId: 'merch-1',
    state: 'fulfilled',
    ctxOrderId: 'ctx-1',
    fulfilledAt: new Date(NOW - 60 * 60 * 1000),
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    attempts: 0,
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

describe('refetchOrderRedemption — eligibility gates', () => {
  it('order_not_found when no row matches', async () => {
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'order_not_found' });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: 'paid' }, 'not_fulfilled'],
    [{ ctxOrderId: null }, 'no_ctx_order_id'],
    [{ redeemCode: 'CODE' }, 'already_present'],
    [{ redeemUrl: 'https://x' }, 'already_present'],
  ])('not_eligible %o → %s', async (overrides, reason) => {
    dbState.rows = [makeRow(overrides as Record<string, unknown>)];
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'not_eligible', reason });
    expect(fetchRedemptionMock).not.toHaveBeenCalled();
  });

  it('pool_unavailable maps the operator-pool error (no attempt burned)', async () => {
    dbState.rows = [makeRow()];
    fetchRedemptionMock.mockRejectedValue(new OperatorPoolUnavailableError('pool down'));
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({ kind: 'pool_unavailable' });
    expect(dbState.updates).toHaveLength(0);
  });
});

describe('refetchOrderRedemption — recovery + bookkeeping', () => {
  it('persists a recovered payload through the idempotent guards', async () => {
    dbState.rows = [makeRow({ attempts: 3 })];
    fetchRedemptionMock.mockResolvedValue({ code: 'CODE', pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toEqual({
      kind: 'recovered',
      attempts: 4,
      hasCode: true,
      hasPin: false,
      hasUrl: false,
    });
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      redeemCode: 'CODE',
      redemptionBackfillAttempts: 4,
    });
  });

  it('losing the persist race still reports recovered (concurrent writer won)', async () => {
    dbState.rows = [makeRow({ attempts: 3 })];
    dbState.updateMatches = false;
    fetchRedemptionMock.mockResolvedValue({ code: 'CODE', pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({ kind: 'recovered', attempts: 3 });
  });

  it('still_empty bumps the attempts counter', async () => {
    dbState.rows = [makeRow({ attempts: 4 })];
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({ kind: 'still_empty', attempts: 5 });
    expect(dbState.updates[0]).toMatchObject({ redemptionBackfillAttempts: 5 });
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('runs past the sweeper cap without re-paging ops (no-cap contract)', async () => {
    // attempts already AT the cap — the sweeper would never pick
    // this row; the admin action must still drive it, and the bump
    // to cap+1 must not re-fire the exhaustion page.
    dbState.rows = [makeRow({ attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS })];
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    const out = await refetchOrderRedemption(ORDER_ID, NOW);
    expect(out).toMatchObject({
      kind: 'still_empty',
      attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS + 1,
    });
    expect(notifyExhaustedMock).not.toHaveBeenCalled();
  });

  it('pages ops exactly when the bump crosses the cap (parity with the sweeper)', async () => {
    dbState.rows = [makeRow({ attempts: REDEMPTION_BACKFILL_MAX_ATTEMPTS - 1 })];
    fetchRedemptionMock.mockResolvedValue({ code: null, pin: null, url: null });
    await refetchOrderRedemption(ORDER_ID, NOW);
    expect(notifyExhaustedMock).toHaveBeenCalledOnce();
  });
});
