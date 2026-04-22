import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const { state, executeMock } = vi.hoisted(() => {
  const state = {
    rows: [] as unknown,
    throwErr: null as Error | null,
  };
  const executeMock = vi.fn(async () => {
    if (state.throwErr !== null) throw state.throwErr;
    return state.rows;
  });
  return { state, executeMock };
});

vi.mock('../../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    state: 'pending_payouts.state',
    assetCode: 'pending_payouts.asset_code',
    amountStroops: 'pending_payouts.amount_stroops',
    confirmedAt: 'pending_payouts.confirmed_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminPayoutsMonthlyHandler } from '../payouts-monthly.js';

function makeCtx(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  executeMock.mockClear();
});

describe('adminPayoutsMonthlyHandler', () => {
  it('returns empty entries when no confirmed payouts in the window', async () => {
    state.rows = [];
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('maps rows into (month, assetCode, stroops, count) entries', async () => {
    state.rows = [
      {
        month: '2026-03-01 00:00:00+00',
        asset_code: 'USDLOOP',
        paid_stroops: '50000000000',
        payout_count: 12n,
      },
      {
        month: '2026-04-01 00:00:00+00',
        asset_code: 'GBPLOOP',
        paid_stroops: 25000000000n,
        payout_count: 5,
      },
    ];
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    const body = (await res.json()) as {
      entries: Array<{
        month: string;
        assetCode: string;
        paidStroops: string;
        payoutCount: number;
      }>;
    };
    expect(body.entries).toEqual([
      { month: '2026-03', assetCode: 'USDLOOP', paidStroops: '50000000000', payoutCount: 12 },
      { month: '2026-04', assetCode: 'GBPLOOP', paidStroops: '25000000000', payoutCount: 5 },
    ]);
  });

  it('formats Date-typed month values to "YYYY-MM"', async () => {
    state.rows = [
      {
        month: new Date(Date.UTC(2026, 0, 1)),
        asset_code: 'EURLOOP',
        paid_stroops: '1000',
        payout_count: 1,
      },
    ];
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ month: string }> };
    expect(body.entries[0]?.month).toBe('2026-01');
  });

  it('preserves bigint precision past 2^53', async () => {
    state.rows = [
      {
        month: '2026-04-01 00:00:00+00',
        asset_code: 'USDLOOP',
        paid_stroops: 9007199254740992n + 17n,
        payout_count: 1n,
      },
    ];
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: Array<{ paidStroops: string }> };
    expect(body.entries[0]?.paidStroops).toBe('9007199254741009');
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [
        {
          month: '2026-04-01 00:00:00+00',
          asset_code: 'USDLOOP',
          paid_stroops: '100',
          payout_count: 1,
        },
      ],
    };
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('coerces null aggregates to "0" / 0 without crashing', async () => {
    state.rows = [
      {
        month: '2026-04-01 00:00:00+00',
        asset_code: 'USDLOOP',
        paid_stroops: null,
        payout_count: null,
      },
    ];
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    const body = (await res.json()) as {
      entries: Array<{ paidStroops: string; payoutCount: number }>;
    };
    expect(body.entries[0]?.paidStroops).toBe('0');
    expect(body.entries[0]?.payoutCount).toBe(0);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPayoutsMonthlyHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
