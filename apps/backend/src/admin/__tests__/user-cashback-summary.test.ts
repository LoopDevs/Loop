import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * DB mock: `db.execute(sql\`...\`)` — the handler runs a single
 * `execute` call and expects either an array of rows or a `{ rows }`
 * envelope (postgres-js vs node-postgres shape). Tests push the
 * desired response into `state.result`; a throw is signalled by
 * setting `state.throw`.
 */
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

// Schema mock — only the columns the handler references by name.
vi.mock('../../db/schema.js', () => ({
  users: 'users',
  creditTransactions: {
    amountMinor: 'amount_minor',
    createdAt: 'created_at',
    userId: 'user_id',
    type: 'type',
    currency: 'currency',
  },
}));

import { adminUserCashbackSummaryHandler } from '../user-cashback-summary.js';

function makeCtx(params: Record<string, string> = {}): Context {
  return {
    req: {
      param: (k: string) => params[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const validUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  state.result = [];
  state.throw = false;
});

describe('adminUserCashbackSummaryHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserCashbackSummaryHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('404 when the user does not exist (empty row set)', async () => {
    state.result = [];
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('happy path — bigint-as-string lifetime + this-month totals', async () => {
    state.result = [
      {
        currency: 'GBP',
        lifetimeMinor: '4200',
        thisMonthMinor: '320',
      },
    ];
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      userId: validUserId,
      currency: 'GBP',
      lifetimeMinor: '4200',
      thisMonthMinor: '320',
    });
  });

  it('user exists but has never earned cashback — returns zeroed totals, not 404', async () => {
    // LEFT JOIN guarantees a row back for an existing user; COALESCE
    // zeroes the SUMs. Handler must surface 0 / 0 rather than
    // treating the row as "missing user".
    state.result = [
      {
        currency: 'USD',
        lifetimeMinor: '0',
        thisMonthMinor: '0',
      },
    ];
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      userId: validUserId,
      currency: 'USD',
      lifetimeMinor: '0',
      thisMonthMinor: '0',
    });
  });

  it('handles the `{ rows }` envelope shape (postgres-js / node-postgres parity)', async () => {
    state.result = {
      rows: [
        {
          currency: 'EUR',
          lifetimeMinor: 15_000n as unknown as string, // bigint-as-bigint is coerced .toString()
          thisMonthMinor: 1_200n as unknown as string,
        },
      ],
    };
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      currency: 'EUR',
      lifetimeMinor: '15000',
      thisMonthMinor: '1200',
    });
  });

  it('500 when the db throws', async () => {
    state.throw = true;
    const res = await adminUserCashbackSummaryHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });
});
