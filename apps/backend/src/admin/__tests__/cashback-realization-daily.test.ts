import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as unknown,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  adminCashbackRealizationDailyHandler,
  recycledBps,
} from '../cashback-realization-daily.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
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
});

describe('recycledBps', () => {
  it('returns 0 on zero earned', () => {
    expect(recycledBps(0n, 0n)).toBe(0);
    expect(recycledBps(0n, 100n)).toBe(0);
  });

  it('computes spent / earned × 10 000', () => {
    expect(recycledBps(100n, 25n)).toBe(2500);
    expect(recycledBps(100n, 50n)).toBe(5000);
  });

  it('clamps overflow + negative spent', () => {
    expect(recycledBps(100n, 200n)).toBe(10000);
    expect(recycledBps(100n, -50n)).toBe(0);
  });
});

describe('adminCashbackRealizationDailyHandler', () => {
  it('returns an empty rows array when no currency rows land (all LEFT-JOIN nulls)', async () => {
    state.rows = [
      { day: '2026-04-01', currency: null, earned_minor: '0', spent_minor: '0' },
      { day: '2026-04-02', currency: null, earned_minor: '0', spent_minor: '0' },
    ];
    const res = await adminCashbackRealizationDailyHandler(makeCtx());
    const body = (await res.json()) as { days: number; rows: unknown[] };
    expect(body.days).toBe(30);
    expect(body.rows).toEqual([]);
  });

  it('strips null-currency rows and keeps real (day, currency) rows with recycledBps computed', async () => {
    state.rows = [
      { day: '2026-04-15', currency: null, earned_minor: '0', spent_minor: '0' },
      { day: '2026-04-15', currency: 'USD', earned_minor: '10000', spent_minor: '2500' },
      { day: '2026-04-16', currency: 'USD', earned_minor: '20000', spent_minor: '10000' },
      { day: '2026-04-16', currency: 'GBP', earned_minor: '5000', spent_minor: '2500' },
    ];
    const res = await adminCashbackRealizationDailyHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<{ day: string; currency: string; recycledBps: number; earnedMinor: string }>;
    };
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toEqual({
      day: '2026-04-15',
      currency: 'USD',
      earnedMinor: '10000',
      spentMinor: '2500',
      recycledBps: 2500, // 2500/10000 = 25.00%
    });
    expect(body.rows[1]!.recycledBps).toBe(5000); // 50%
    expect(body.rows[2]!.recycledBps).toBe(5000); // 50%
  });

  it('clamps ?days to 1..180', async () => {
    const over = await adminCashbackRealizationDailyHandler(makeCtx({ days: '900' }));
    const overBody = (await over.json()) as { days: number };
    expect(overBody.days).toBe(180);

    const under = await adminCashbackRealizationDailyHandler(makeCtx({ days: '0' }));
    const underBody = (await under.json()) as { days: number };
    expect(underBody.days).toBe(1);

    const nan = await adminCashbackRealizationDailyHandler(makeCtx({ days: 'NaN' }));
    const nanBody = (await nan.json()) as { days: number };
    expect(nanBody.days).toBe(30);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [{ day: '2026-04-20', currency: 'USD', earned_minor: '1000', spent_minor: '250' }],
    };
    const res = await adminCashbackRealizationDailyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['recycledBps']).toBe(2500);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackRealizationDailyHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('accepts Date objects in the day column (pg returns Date for date types)', async () => {
    state.rows = [
      {
        day: new Date('2026-04-15T00:00:00Z'),
        currency: 'USD',
        earned_minor: '1000',
        spent_minor: '500',
      },
    ];
    const res = await adminCashbackRealizationDailyHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ day: string }> };
    expect(body.rows[0]!.day).toBe('2026-04-15');
  });
});
