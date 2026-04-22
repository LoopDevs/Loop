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

import { adminPayoutsActivityHandler } from '../payouts-activity.js';

function makeCtx(query: Record<string, string | undefined> = {}): Context {
  return {
    req: { query: (k: string) => query[k] },
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

describe('adminPayoutsActivityHandler', () => {
  it('defaults to 30 days when ?days is missing', async () => {
    state.rows = [];
    const res = await adminPayoutsActivityHandler(makeCtx());
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(30);
  });

  it('clamps ?days into [1, 180]', async () => {
    state.rows = [];
    const tooBig = await adminPayoutsActivityHandler(makeCtx({ days: '500' }));
    expect(((await tooBig.json()) as { days: number }).days).toBe(180);
    const tooSmall = await adminPayoutsActivityHandler(makeCtx({ days: '0' }));
    expect(((await tooSmall.json()) as { days: number }).days).toBe(1);
  });

  it('coerces non-numeric ?days to default 30', async () => {
    state.rows = [];
    const res = await adminPayoutsActivityHandler(makeCtx({ days: 'banana' }));
    expect(((await res.json()) as { days: number }).days).toBe(30);
  });

  it('emits one row per day, zero-filled for LEFT-JOIN gap days', async () => {
    // Simulate two days: one with activity, one empty (asset_code null).
    state.rows = [
      { day: '2026-04-20', asset_code: null, count: 0n, stroops: 0n },
      { day: '2026-04-21', asset_code: 'USDLOOP', count: 3n, stroops: 12000000n },
    ];
    const res = await adminPayoutsActivityHandler(makeCtx({ days: '2' }));
    const body = (await res.json()) as {
      rows: Array<{ day: string; count: number; byAsset: Array<{ assetCode: string }> }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({ day: '2026-04-20', count: 0, byAsset: [] });
    expect(body.rows[1]?.day).toBe('2026-04-21');
    expect(body.rows[1]?.count).toBe(3);
    expect(body.rows[1]?.byAsset[0]?.assetCode).toBe('USDLOOP');
  });

  it('rolls multi-asset days up into one entry with each asset as a byAsset row', async () => {
    state.rows = [
      { day: '2026-04-22', asset_code: 'USDLOOP', count: 5n, stroops: 50000000n },
      { day: '2026-04-22', asset_code: 'GBPLOOP', count: 2n, stroops: 20000000n },
    ];
    const res = await adminPayoutsActivityHandler(makeCtx({ days: '1' }));
    const body = (await res.json()) as {
      rows: Array<{ count: number; byAsset: Array<{ assetCode: string; count: number }> }>;
    };
    const row = body.rows[0]!;
    expect(row.count).toBe(7);
    expect(row.byAsset).toHaveLength(2);
    expect(row.byAsset.find((a) => a.assetCode === 'USDLOOP')?.count).toBe(5);
    expect(row.byAsset.find((a) => a.assetCode === 'GBPLOOP')?.count).toBe(2);
  });

  it('formats Date-typed day values to YYYY-MM-DD', async () => {
    state.rows = [
      {
        day: new Date(Date.UTC(2026, 3, 22)),
        asset_code: 'USDLOOP',
        count: 1n,
        stroops: 100000n,
      },
    ];
    const res = await adminPayoutsActivityHandler(makeCtx({ days: '1' }));
    const body = (await res.json()) as { rows: Array<{ day: string }> };
    expect(body.rows[0]?.day).toBe('2026-04-22');
  });

  it('preserves bigint precision past 2^53 on stroops', async () => {
    state.rows = [
      {
        day: '2026-04-22',
        asset_code: 'USDLOOP',
        count: 1n,
        stroops: 9007199254740992n + 29n,
      },
    ];
    const res = await adminPayoutsActivityHandler(makeCtx({ days: '1' }));
    const body = (await res.json()) as { rows: Array<{ byAsset: Array<{ stroops: string }> }> };
    expect(body.rows[0]?.byAsset[0]?.stroops).toBe('9007199254741021');
  });

  it('handles the { rows } envelope shape', async () => {
    state.rows = {
      rows: [{ day: '2026-04-22', asset_code: 'USDLOOP', count: 1n, stroops: 100n }],
    };
    const res = await adminPayoutsActivityHandler(makeCtx({ days: '1' }));
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminPayoutsActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
