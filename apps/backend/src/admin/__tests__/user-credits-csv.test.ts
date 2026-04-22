import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as Array<{
      userId: string;
      email: string;
      currency: string;
      balanceMinor: bigint;
      updatedAt: Date;
    }>,
    throw: false,
  },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    innerJoin: vi.fn(() => leaf),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async () => {
      if (dbState.throw) throw new Error('db exploded');
      return dbState.rows;
    }),
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => leaf) })),
    },
  };
});
vi.mock('../../db/schema.js', () => ({
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    balanceMinor: 'balance_minor',
    updatedAt: 'updated_at',
  },
  users: { id: 'id', email: 'email' },
}));

import { adminUserCreditsCsvHandler } from '../user-credits-csv.js';

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
  dbState.rows = [];
  dbState.throw = false;
});

describe('adminUserCreditsCsvHandler', () => {
  it('emits CSV with header + rows, bigint balance, attachment + private cache', async () => {
    dbState.rows = [
      {
        userId: 'u-1',
        email: 'alice@example.com',
        currency: 'GBP',
        balanceMinor: 420_00n,
        updatedAt: new Date('2026-04-21T10:00:00Z'),
      },
    ];
    const res = await adminUserCreditsCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="loop-user-credits.csv"',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe('User ID,Email,Currency,Balance (minor),Updated at (UTC)');
    expect(lines[1]).toBe('u-1,alice@example.com,GBP,42000,2026-04-21T10:00:00.000Z');
  });

  it('RFC-4180-escapes emails with commas / quotes', async () => {
    dbState.rows = [
      {
        userId: 'u-x',
        email: 'weird,email"with".chars@example.com',
        currency: 'USD',
        balanceMinor: 0n,
        updatedAt: new Date('2026-04-20T00:00:00Z'),
      },
    ];
    const res = await adminUserCreditsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"weird,email""with"".chars@example.com"');
  });

  it('serialises very large bigint balances without precision loss', async () => {
    const huge = 99_999_999_999_999_999_999n;
    dbState.rows = [
      {
        userId: 'u-1',
        email: 'a@b.com',
        currency: 'GBP',
        balanceMinor: huge,
        updatedAt: new Date('2026-04-20T00:00:00Z'),
      },
    ];
    const res = await adminUserCreditsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain(',99999999999999999999,');
  });

  it('emits only the header when there are no balances', async () => {
    dbState.rows = [];
    const res = await adminUserCreditsCsvHandler(makeCtx());
    expect((await res.text()).trim().split('\r\n')).toHaveLength(1);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await adminUserCreditsCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
