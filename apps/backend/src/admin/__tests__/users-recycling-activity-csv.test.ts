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

import { adminUsersRecyclingActivityCsvHandler } from '../users-recycling-activity-csv.js';

function makeCtx(): Context {
  return {
    req: {},
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

describe('adminUsersRecyclingActivityCsvHandler', () => {
  it('empty fleet — returns CSV with headers only + attachment disposition', async () => {
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="users-recycling-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'user_id,email,currency,last_recycled_at,recycled_order_count,recycled_charge_minor',
    );
  });

  it('happy path — one row per user with ISO last_recycled_at + bigint-as-string charge', async () => {
    state.result = [
      {
        user_id: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        last_recycled_at: '2026-04-22T10:00:00.000Z',
        recycled_order_count: 5,
        recycled_charge_minor: '12500',
      },
      {
        user_id: 'u-2',
        email: 'bob@example.com',
        currency: 'USD',
        last_recycled_at: new Date('2026-04-21T15:30:00.000Z'),
        recycled_order_count: 2,
        recycled_charge_minor: '4000',
      },
    ];
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('u-1,alice@example.com,GBP,2026-04-22T10:00:00.000Z,5,12500');
    expect(lines[2]).toBe('u-2,bob@example.com,USD,2026-04-21T15:30:00.000Z,2,4000');
  });

  it('CSV-escapes emails containing commas / quotes (edge case, but safe)', async () => {
    state.result = [
      {
        user_id: 'u-1',
        // RFC 5321 allows quoted-local emails like "foo,bar"@example.com
        email: '"weird,email"@example.com',
        currency: 'GBP',
        last_recycled_at: '2026-04-22T10:00:00.000Z',
        recycled_order_count: 1,
        recycled_charge_minor: '100',
      },
    ];
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    const body = await res.text();
    // The quotes + comma trip the escape — surrounding quotes added,
    // inner quotes doubled.
    expect(body).toContain('"""weird,email""@example.com"');
  });

  it('preserves bigint precision past 2^53 on recycled_charge_minor', async () => {
    state.result = [
      {
        user_id: 'u-1',
        email: 'a@b.com',
        currency: 'GBP',
        last_recycled_at: '2026-04-22T10:00:00.000Z',
        recycled_order_count: 1,
        recycled_charge_minor: 9007199254740992n + 7n,
      },
    ];
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('9007199254740999');
  });

  it('appends __TRUNCATED__ sentinel when the query yields ROW_CAP + 1 rows', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10_001; i++) {
      rows.push({
        user_id: `u-${i}`,
        email: `user${i}@example.com`,
        currency: 'GBP',
        last_recycled_at: '2026-04-22T10:00:00.000Z',
        recycled_order_count: 1,
        recycled_charge_minor: '100',
      });
    }
    state.result = rows;
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // header + 10 000 rows + __TRUNCATED__ sentinel
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('handles the `{ rows }` envelope shape', async () => {
    state.result = {
      rows: [
        {
          user_id: 'u-x',
          email: 'x@y.com',
          currency: 'EUR',
          last_recycled_at: '2026-04-22T10:00:00.000Z',
          recycled_order_count: 3,
          recycled_charge_minor: '900',
        },
      ],
    };
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('u-x,x@y.com,EUR,2026-04-22T10:00:00.000Z,3,900');
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminUsersRecyclingActivityCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
