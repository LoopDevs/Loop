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
  orders: {
    id: 'id',
    state: 'state',
    createdAt: 'created_at',
  },
}));

import { adminOrdersActivityHandler } from '../orders-activity.js';

function makeCtx(query: Record<string, string> = {}): Context {
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
  execState.rows = [];
  execState.throw = false;
});

describe('adminOrdersActivityHandler', () => {
  it('happy path — returns days oldest-first + echoes windowDays default 7', async () => {
    execState.rows = [
      { day: '2026-04-16', created: 5, fulfilled: 3 },
      { day: '2026-04-17', created: 8, fulfilled: 6 },
      { day: '2026-04-22', created: 12, fulfilled: 9 },
    ];
    const res = await adminOrdersActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      days: Array<{ day: string; created: number; fulfilled: number }>;
    };
    expect(body.windowDays).toBe(7);
    expect(body.days).toHaveLength(3);
    expect(body.days[0]).toEqual({ day: '2026-04-16', created: 5, fulfilled: 3 });
    expect(body.days[2]?.day).toBe('2026-04-22');
  });

  it('accepts custom ?days within bounds', async () => {
    execState.rows = [];
    const res = await adminOrdersActivityHandler(makeCtx({ days: '30' }));
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(30);
  });

  it('clamps ?days — huge caps at 90, malformed falls back to 7, zero floors to 1', async () => {
    execState.rows = [];
    let body = (await (await adminOrdersActivityHandler(makeCtx({ days: '9999' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(90);

    body = (await (await adminOrdersActivityHandler(makeCtx({ days: 'nope' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(7);

    body = (await (await adminOrdersActivityHandler(makeCtx({ days: '0' }))).json()) as {
      windowDays: number;
    };
    expect(body.windowDays).toBe(1);
  });

  it('coerces Date-typed day values to YYYY-MM-DD (some drivers skip TO_CHAR)', async () => {
    execState.rows = [
      {
        day: new Date('2026-04-20T00:00:00Z'),
        created: 1,
        fulfilled: 1,
      },
    ];
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as { days: Array<{ day: string }> };
    expect(body.days[0]?.day).toBe('2026-04-20');
  });

  it('returns an empty day list when the query matches nothing', async () => {
    execState.rows = [];
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toEqual([]);
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [{ day: '2026-04-22', created: 1, fulfilled: 0 }],
    };
    const res = await adminOrdersActivityHandler(makeCtx());
    const body = (await res.json()) as { days: Array<{ day: string }> };
    expect(body.days).toHaveLength(1);
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminOrdersActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
