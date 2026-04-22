import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { queryState } = vi.hoisted(() => ({
  queryState: {
    row: null as unknown,
    lastWhereEmail: null as string | null,
    throw: false,
  },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(async (opts: { where?: unknown }) => {
          if (queryState.throw) throw new Error('db exploded');
          // Pull the email literal out of the drizzle eq() call — the
          // shape we mock for `eq` makes this trivial since we're
          // also mocking drizzle-orm below.
          const where = opts.where as { email?: string } | undefined;
          queryState.lastWhereEmail = where?.email ?? null;
          return queryState.row;
        }),
      },
    },
  },
}));
vi.mock('../../db/schema.js', () => ({
  users: {
    email: 'email',
  },
}));
vi.mock('drizzle-orm', () => ({
  // Our eq mock returns a recognisable object so the handler mock can
  // extract the literal value without parsing drizzle internals.
  eq: (_col: unknown, value: unknown) => ({ email: value }),
}));

import { adminUserByEmailHandler } from '../user-by-email.js';

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
  queryState.row = null;
  queryState.lastWhereEmail = null;
  queryState.throw = false;
});

describe('adminUserByEmailHandler', () => {
  it('400 when email query is missing', async () => {
    const res = await adminUserByEmailHandler(makeCtx());
    expect(res.status).toBe(400);
  });

  it('400 when email fails the shape regex', async () => {
    for (const bad of ['not-an-email', '@x.com', 'x@y', 'a@b.c@d.e']) {
      const res = await adminUserByEmailHandler(makeCtx({ email: bad }));
      expect(res.status).toBe(400);
    }
  });

  it('400 when email is absurdly long', async () => {
    const res = await adminUserByEmailHandler(makeCtx({ email: `${'a'.repeat(250)}@b.com` }));
    expect(res.status).toBe(400);
  });

  it('404 when no user matches', async () => {
    queryState.row = undefined;
    const res = await adminUserByEmailHandler(makeCtx({ email: 'missing@example.com' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('200 with the user view on match', async () => {
    queryState.row = {
      id: 'u-1',
      email: 'alice@example.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: new Date('2026-04-20T12:00:00Z'),
      updatedAt: new Date('2026-04-21T09:00:00Z'),
    };
    const res = await adminUserByEmailHandler(makeCtx({ email: 'alice@example.com' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; homeCurrency: string } };
    expect(body.user.id).toBe('u-1');
    expect(body.user.homeCurrency).toBe('GBP');
  });

  it('normalises uppercase email to lowercase before lookup', async () => {
    queryState.row = {
      id: 'u-2',
      email: 'alice@example.com',
      isAdmin: false,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: new Date('2026-04-20T12:00:00Z'),
      updatedAt: new Date('2026-04-20T12:00:00Z'),
    };
    await adminUserByEmailHandler(makeCtx({ email: 'Alice@Example.COM' }));
    expect(queryState.lastWhereEmail).toBe('alice@example.com');
  });

  it('500 when the db read throws', async () => {
    queryState.throw = true;
    const res = await adminUserByEmailHandler(makeCtx({ email: 'x@y.com' }));
    expect(res.status).toBe(500);
  });
});
