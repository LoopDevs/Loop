import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type * as DrizzleOrm from 'drizzle-orm';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * The handler's query is
 *   db.select(...).from(users).where(ilike(...)).orderBy(...).limit(N)
 * so the mock chain terminates at `.limit()`. Tests push rows into
 * `dbState.rows`; the handler slices + flags truncation based on the
 * returned count vs RESULT_LIMIT (20).
 *
 * We also capture the `ilike` condition argument so one test can
 * verify escape behaviour on wildcard characters without re-mocking
 * drizzle-orm itself.
 */
const { dbState, ilikeCalls } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
  },
  ilikeCalls: [] as Array<{ column: unknown; pattern: string }>,
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = (await importActual()) as typeof DrizzleOrm;
  return {
    ...actual,
    ilike: (column: unknown, pattern: string) => {
      ilikeCalls.push({ column, pattern });
      return { __ilike: pattern };
    },
    desc: actual.desc,
  };
});

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn(() => leaf),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async () => dbState.rows),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => leaf),
      })),
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    email: 'email',
    isAdmin: 'isAdmin',
    homeCurrency: 'homeCurrency',
    createdAt: 'createdAt',
  },
}));

import { adminUserSearchHandler } from '../user-search.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  dbState.rows = [];
  ilikeCalls.length = 0;
});

describe('adminUserSearchHandler', () => {
  it('400s when q is shorter than the minimum', async () => {
    const res = await adminUserSearchHandler(makeCtx({ q: 'a' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400s when q is missing', async () => {
    const res = await adminUserSearchHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400s when q exceeds the 254-char email cap', async () => {
    const res = await adminUserSearchHandler(makeCtx({ q: 'x'.repeat(300) }));
    expect(res.status).toBe(400);
  });

  it('trims whitespace before the length check', async () => {
    // "  a  " trims to "a" which is below the minimum — still 400.
    const res = await adminUserSearchHandler(makeCtx({ q: '  a  ' }));
    expect(res.status).toBe(400);
  });

  it('returns shaped results with ISO createdAt and untruncated flag', async () => {
    dbState.rows = [
      {
        id: 'u1',
        email: 'alice@example.com',
        isAdmin: false,
        homeCurrency: 'GBP',
        createdAt: new Date('2026-04-01T10:00:00.000Z'),
      },
      {
        id: 'u2',
        email: 'alice@work.com',
        isAdmin: true,
        homeCurrency: 'USD',
        createdAt: new Date('2026-04-02T10:00:00.000Z'),
      },
    ];
    const res = await adminUserSearchHandler(makeCtx({ q: 'alice' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ id: string; email: string; isAdmin: boolean; createdAt: string }>;
      truncated: boolean;
    };
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      isAdmin: false,
      createdAt: '2026-04-01T10:00:00.000Z',
    });
    expect(body.users[1]?.isAdmin).toBe(true);
    expect(body.truncated).toBe(false);
  });

  it('truncates at 20 results and flags truncated=true when more exist', async () => {
    // Push 21 rows; handler returns 20 and sets truncated=true.
    dbState.rows = Array.from({ length: 21 }, (_, i) => ({
      id: `u${i}`,
      email: `user${i}@ex.com`,
      isAdmin: false,
      homeCurrency: 'USD',
      createdAt: new Date(`2026-04-01T00:00:${String(i).padStart(2, '0')}.000Z`),
    }));
    const res = await adminUserSearchHandler(makeCtx({ q: 'user' }));
    const body = (await res.json()) as {
      users: unknown[];
      truncated: boolean;
    };
    expect(body.users).toHaveLength(20);
    expect(body.truncated).toBe(true);
  });

  it('escapes ILIKE wildcards so search for "a_b" does not match "axb"', async () => {
    dbState.rows = [];
    await adminUserSearchHandler(makeCtx({ q: 'a_b' }));
    const call = ilikeCalls.at(-1);
    expect(call?.pattern).toBe('%a\\_b%');
  });

  it('escapes percent wildcards too', async () => {
    dbState.rows = [];
    await adminUserSearchHandler(makeCtx({ q: '50%off' }));
    const call = ilikeCalls.at(-1);
    expect(call?.pattern).toBe('%50\\%off%');
  });

  it('escapes backslashes before percent / underscore so the escape chain is reversible', async () => {
    dbState.rows = [];
    await adminUserSearchHandler(makeCtx({ q: 'a\\b' }));
    const call = ilikeCalls.at(-1);
    // The backslash should be escaped first, then any % / _ afterwards.
    expect(call?.pattern).toBe('%a\\\\b%');
  });

  it('returns an empty users array + truncated=false on zero matches', async () => {
    dbState.rows = [];
    const res = await adminUserSearchHandler(makeCtx({ q: 'nohit' }));
    const body = (await res.json()) as { users: unknown[]; truncated: boolean };
    expect(body.users).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});
