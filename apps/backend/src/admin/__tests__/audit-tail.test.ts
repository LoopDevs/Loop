import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  limitArg: null as null | number,
  whereCalled: false,
}));

vi.mock('../../db/client.js', () => {
  const chain = (): Record<string, unknown> => {
    const api: Record<string, unknown> = {};
    const self: Record<string, (arg?: unknown) => unknown> = {
      select: () => api,
      from: () => api,
      innerJoin: () => api,
      where: () => {
        state.whereCalled = true;
        return api;
      },
      orderBy: () => api,
      limit: (n: unknown) => {
        state.limitArg = typeof n === 'number' ? n : null;
        if (state.throwErr !== null) return Promise.reject(state.throwErr);
        return Promise.resolve(state.rows);
      },
    };
    Object.assign(api, self);
    return api;
  };
  return {
    db: chain(),
  };
});

vi.mock('../../db/schema.js', () => ({
  adminIdempotencyKeys: {
    adminUserId: 'admin_idempotency_keys.admin_user_id',
    method: 'admin_idempotency_keys.method',
    path: 'admin_idempotency_keys.path',
    status: 'admin_idempotency_keys.status',
    createdAt: 'admin_idempotency_keys.created_at',
  },
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    desc: (v: unknown) => v,
    eq: (_a: unknown, _b: unknown) => true,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => ({ sql: strings.join('?') }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminAuditTailHandler } from '../audit-tail.js';

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
  state.rows = [];
  state.throwErr = null;
  state.limitArg = null;
  state.whereCalled = false;
});

describe('adminAuditTailHandler', () => {
  it('defaults to limit 25 when no query is set', async () => {
    await adminAuditTailHandler(makeCtx());
    expect(state.limitArg).toBe(25);
  });

  it('clamps limit to the [1, 100] range', async () => {
    await adminAuditTailHandler(makeCtx({ limit: '0' }));
    expect(state.limitArg).toBe(1);
    await adminAuditTailHandler(makeCtx({ limit: '9999' }));
    expect(state.limitArg).toBe(100);
    await adminAuditTailHandler(makeCtx({ limit: 'not-a-number' }));
    expect(state.limitArg).toBe(25);
  });

  it('returns the mapped view with email + ISO timestamp', async () => {
    state.rows = [
      {
        adminUserId: '11111111-1111-1111-1111-111111111111',
        method: 'POST',
        path: '/api/admin/users/u1/credit-adjustments',
        status: 200,
        createdAt: new Date('2026-04-22T10:00:00Z'),
        actorEmail: 'admin@loop.test',
      },
    ];
    const res = await adminAuditTailHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      actorUserId: '11111111-1111-1111-1111-111111111111',
      actorEmail: 'admin@loop.test',
      method: 'POST',
      status: 200,
      createdAt: '2026-04-22T10:00:00.000Z',
    });
  });

  it('500s when the db throws', async () => {
    state.throwErr = new Error('db down');
    const res = await adminAuditTailHandler(makeCtx());
    expect(res.status).toBe(500);
  });

  it('skips the where() clause when no before cursor is given', async () => {
    await adminAuditTailHandler(makeCtx());
    expect(state.whereCalled).toBe(false);
  });

  it('applies a where() clause when before is a valid ISO timestamp', async () => {
    const res = await adminAuditTailHandler(makeCtx({ before: '2026-04-22T12:00:00Z' }));
    expect(res.status).toBe(200);
    expect(state.whereCalled).toBe(true);
  });

  it('400s when before is not a parseable timestamp', async () => {
    const res = await adminAuditTailHandler(makeCtx({ before: 'not-a-date' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(state.whereCalled).toBe(false);
  });
});
