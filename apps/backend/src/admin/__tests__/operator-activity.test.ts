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

vi.mock('../../db/schema.js', () => ({
  orders: {
    id: 'orders.id',
    state: 'orders.state',
    createdAt: 'orders.created_at',
    ctxOperatorId: 'orders.ctx_operator_id',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminOperatorActivityHandler } from '../operator-activity.js';

function makeCtx(
  params: Record<string, string | undefined> = {},
  query: Record<string, string | undefined> = {},
): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (k: string) => params[k],
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

describe('adminOperatorActivityHandler', () => {
  it('400 when operatorId is missing', async () => {
    const res = await adminOperatorActivityHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId has disallowed characters', async () => {
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('400 when operatorId exceeds 128 chars', async () => {
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });

  it('returns empty rows (zero-volume operator) with echoed windowDays', async () => {
    state.rows = [];
    const res = await adminOperatorActivityHandler(
      makeCtx({ operatorId: 'drained_operator' }, { days: '14' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operatorId: string;
      days: unknown[];
      windowDays: number;
    };
    expect(body.operatorId).toBe('drained_operator');
    expect(body.days).toEqual([]);
    expect(body.windowDays).toBe(14);
  });

  it('defaults to 7 days when ?days is omitted', async () => {
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(7);
  });

  it('clamps ?days to [1, 90]', async () => {
    const below = await adminOperatorActivityHandler(
      makeCtx({ operatorId: 'primary' }, { days: '0' }),
    );
    expect(((await below.json()) as { windowDays: number }).windowDays).toBe(1);

    const above = await adminOperatorActivityHandler(
      makeCtx({ operatorId: 'primary' }, { days: '365' }),
    );
    expect(((await above.json()) as { windowDays: number }).windowDays).toBe(90);
  });

  it('coerces NaN ?days back to default 7', async () => {
    const res = await adminOperatorActivityHandler(
      makeCtx({ operatorId: 'primary' }, { days: 'nope' }),
    );
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(7);
  });

  it('maps rows into the activity-day shape', async () => {
    state.rows = [
      { day: '2026-04-20', created: 42n, fulfilled: '38', failed: 3 },
      { day: new Date('2026-04-21T00:00:00Z'), created: 7, fulfilled: 6n, failed: '1' },
    ];
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as {
      days: Array<Record<string, unknown>>;
    };
    expect(body.days).toEqual([
      { day: '2026-04-20', created: 42, fulfilled: 38, failed: 3 },
      { day: '2026-04-21', created: 7, fulfilled: 6, failed: 1 },
    ]);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [{ day: '2026-04-22', created: 1, fulfilled: 1, failed: 0 }],
    };
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'primary' }));
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminOperatorActivityHandler(makeCtx({ operatorId: 'primary' }));
    expect(res.status).toBe(500);
  });
});
