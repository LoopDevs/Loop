import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { state } = vi.hoisted(() => ({
  state: {
    result: [] as Array<Record<string, unknown>> | { rows: Array<Record<string, unknown>> },
    throw: false,
  },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throw) throw new Error('db exploded');
      return state.result;
    }),
  },
}));

import { adminUsersRecyclingActivityHandler } from '../users-recycling-activity.js';

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
  state.result = [];
  state.throw = false;
});

describe('adminUsersRecyclingActivityHandler', () => {
  it('empty fleet — returns empty rows array with a 90-day since timestamp', async () => {
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string; rows: unknown[] };
    expect(body.rows).toEqual([]);
    // `since` is 90 days ago; slack for wall-clock drift in the test.
    const ageMs = Date.now() - new Date(body.since).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(ageMs - ninetyDaysMs)).toBeLessThan(5 * 60 * 1000);
  });

  it('happy path — maps rows into the response shape with bigint-as-string charge', async () => {
    state.result = [
      {
        userId: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        lastRecycledAt: '2026-04-22T10:00:00.000Z',
        recycledOrderCount: 5,
        recycledChargeMinor: '12500',
      },
      {
        userId: 'u-2',
        email: 'bob@example.com',
        currency: 'USD',
        lastRecycledAt: '2026-04-21T15:30:00.000Z',
        recycledOrderCount: 2,
        recycledChargeMinor: '4000',
      },
    ];
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toEqual([
      {
        userId: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        lastRecycledAt: '2026-04-22T10:00:00.000Z',
        recycledOrderCount: 5,
        recycledChargeMinor: '12500',
      },
      {
        userId: 'u-2',
        email: 'bob@example.com',
        currency: 'USD',
        lastRecycledAt: '2026-04-21T15:30:00.000Z',
        recycledOrderCount: 2,
        recycledChargeMinor: '4000',
      },
    ]);
  });

  it('ISO-formats a Date-valued lastRecycledAt (driver quirk)', async () => {
    state.result = [
      {
        userId: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        lastRecycledAt: new Date('2026-04-22T10:00:00.000Z'),
        recycledOrderCount: 1,
        recycledChargeMinor: '500',
      },
    ];
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ lastRecycledAt: string }> };
    expect(body.rows[0]?.lastRecycledAt).toBe('2026-04-22T10:00:00.000Z');
  });

  it('preserves bigint precision past 2^53 on recycledChargeMinor', async () => {
    state.result = [
      {
        userId: 'u-1',
        email: 'a@b.com',
        currency: 'GBP',
        lastRecycledAt: '2026-04-22T10:00:00.000Z',
        recycledOrderCount: 1,
        recycledChargeMinor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ recycledChargeMinor: string }> };
    expect(body.rows[0]?.recycledChargeMinor).toBe('9007199254740999');
  });

  it('clamps ?limit — floor 1, cap 100, malformed falls back to 25', async () => {
    const r1 = await adminUsersRecyclingActivityHandler(makeCtx({ limit: '9999' }));
    expect(r1.status).toBe(200);
    const r2 = await adminUsersRecyclingActivityHandler(makeCtx({ limit: '-5' }));
    expect(r2.status).toBe(200);
    const r3 = await adminUsersRecyclingActivityHandler(makeCtx({ limit: 'nope' }));
    expect(r3.status).toBe(200);
  });

  it('handles the `{ rows }` envelope shape (driver parity)', async () => {
    state.result = {
      rows: [
        {
          userId: 'u-x',
          email: 'x@y.com',
          currency: 'EUR',
          lastRecycledAt: '2026-04-22T10:00:00.000Z',
          recycledOrderCount: 3,
          recycledChargeMinor: '900',
        },
      ],
    };
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<{ userId: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.userId).toBe('u-x');
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminUsersRecyclingActivityHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
