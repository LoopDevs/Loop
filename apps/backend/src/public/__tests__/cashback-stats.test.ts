import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[] | { rows: unknown[] }, throw: false },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    active: 'active',
    userCashbackPct: 'user_cashback_pct',
  },
}));

import { publicCashbackStatsHandler } from '../cashback-stats.js';

function makeCtx(): Context {
  const headers = new Headers();
  return {
    req: { query: () => undefined },
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...Object.fromEntries(headers) },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  execState.rows = [];
  execState.throw = false;
});

describe('publicCashbackStatsHandler', () => {
  it('happy path — returns count + averages + cache header', async () => {
    execState.rows = [{ n: 42, avgPct: '12.345', maxPct: '20.00' }];
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      merchantsWithCashback: number;
      averageCashbackPct: string;
      topCashbackPct: string;
    };
    expect(body).toEqual({
      merchantsWithCashback: 42,
      averageCashbackPct: '12.35',
      topCashbackPct: '20.00',
    });
  });

  it('returns zero shape when the filter matches no rows', async () => {
    // AVG/MAX over zero rows → null from Postgres.
    execState.rows = [{ n: 0, avgPct: null, maxPct: null }];
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as {
      merchantsWithCashback: number;
      averageCashbackPct: string;
      topCashbackPct: string;
    };
    expect(body).toEqual({
      merchantsWithCashback: 0,
      averageCashbackPct: '0.00',
      topCashbackPct: '0.00',
    });
  });

  it('handles numeric avgPct (some drivers return number not string)', async () => {
    execState.rows = [{ n: 3, avgPct: 15.75, maxPct: '18.00' }];
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as { averageCashbackPct: string };
    expect(body.averageCashbackPct).toBe('15.75');
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [{ n: 1, avgPct: '10.00', maxPct: '10.00' }],
    };
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as { merchantsWithCashback: number };
    expect(body.merchantsWithCashback).toBe(1);
  });

  it('serves zero shape + short cache on db failure (never 500s public)', async () => {
    execState.throw = true;
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    // Shorter cache on fallback so a transient DB blip doesn't leave
    // "0 merchants" up for 5 minutes at the edge.
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as { merchantsWithCashback: number };
    expect(body.merchantsWithCashback).toBe(0);
  });

  it('handles an empty result set (no rows at all)', async () => {
    execState.rows = [];
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as { merchantsWithCashback: number };
    expect(body.merchantsWithCashback).toBe(0);
  });
});
