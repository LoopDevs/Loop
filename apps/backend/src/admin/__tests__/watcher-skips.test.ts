/**
 * Watcher skip-row browser + reopen action (ADR 037 §4.4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reopenResult: null as null | { paymentId: string; attempts: number },
  reopenCalls: [] as string[],
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

/** Awaitable drizzle-ish chain resolving to state.rows. */
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain['then'] = (resolve: (rows: unknown[]) => void) => Promise.resolve(resolve(state.rows));
  return chain;
}

vi.mock('../../db/client.js', () => ({
  db: { select: () => makeChain() },
}));

vi.mock('../../payments/skipped-payments.js', () => ({
  reopenAbandonedSkip: vi.fn(async (paymentId: string) => {
    state.reopenCalls.push(paymentId);
    return state.reopenResult;
  }),
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: unknown,
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  adminGetWatcherSkipHandler,
  adminListWatcherSkipsHandler,
  adminReopenWatcherSkipHandler,
} from '../watcher-skips.js';

const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'support@loop.test' };
const validKey = 'k'.repeat(32);

const dbRow = {
  paymentId: '12345',
  memo: 'ABCDEFGHIJKLMNOPQRST',
  orderId: null,
  reason: 'processing_error',
  status: 'abandoned',
  attempts: 2880,
  lastError: 'boom',
  createdAt: new Date('2026-06-10T00:00:00Z'),
  updatedAt: new Date('2026-06-11T00:00:00Z'),
};

function makeCtx(args: {
  paymentId?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'paymentId' ? args.paymentId : undefined),
      query: (k: string) => args.query?.[k],
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.rows = [];
  state.reopenResult = { paymentId: '12345', attempts: 0 };
  state.reopenCalls = [];
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminListWatcherSkipsHandler', () => {
  it('maps rows to the wire shape (dates → ISO)', async () => {
    state.rows = [dbRow];
    const res = await adminListWatcherSkipsHandler(makeCtx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toEqual({
      paymentId: '12345',
      memo: 'ABCDEFGHIJKLMNOPQRST',
      orderId: null,
      reason: 'processing_error',
      status: 'abandoned',
      attempts: 2880,
      lastError: 'boom',
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
    });
  });

  it('rejects unknown status / reason / cursor with 400', async () => {
    expect(
      (await adminListWatcherSkipsHandler(makeCtx({ query: { status: 'zombie' } }))).status,
    ).toBe(400);
    expect((await adminListWatcherSkipsHandler(makeCtx({ query: { reason: 'nah' } }))).status).toBe(
      400,
    );
    expect(
      (await adminListWatcherSkipsHandler(makeCtx({ query: { before: 'not-a-date' } }))).status,
    ).toBe(400);
  });
});

describe('adminGetWatcherSkipHandler', () => {
  it('400 on a malformed paymentId, 404 when missing, 200 with snapshot', async () => {
    expect((await adminGetWatcherSkipHandler(makeCtx({ paymentId: 'DROP TABLE' }))).status).toBe(
      400,
    );
    expect((await adminGetWatcherSkipHandler(makeCtx({ paymentId: '99' }))).status).toBe(404);
    state.rows = [{ ...dbRow, payment: { amount: '1.0000000' } }];
    const res = await adminGetWatcherSkipHandler(makeCtx({ paymentId: '12345' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['payment']).toEqual({ amount: '1.0000000' });
  });
});

describe('adminReopenWatcherSkipHandler', () => {
  const reopen = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
    adminReopenWatcherSkipHandler(
      makeCtx({
        paymentId: '12345',
        headers: { 'idempotency-key': validKey },
        body: { reason: 'root cause fixed, replaying deposit' },
        ...over,
      }),
    );

  it('200: abandoned → pending with attempts reset, envelope + audit', async () => {
    state.rows = [{ status: 'abandoned' }];
    const res = await reopen();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({
      paymentId: '12345',
      priorStatus: 'abandoned',
      status: 'pending',
      attempts: 0,
    });
    expect(body.audit).toMatchObject({ actorUserId: actor.id, replayed: false });
    expect(state.reopenCalls).toEqual(['12345']);
    expect(state.discordCalls).toHaveLength(1);
  });

  it('404 when the row does not exist', async () => {
    state.rows = [];
    const res = await reopen();
    expect(res.status).toBe(404);
    expect(state.reopenCalls).toEqual([]);
  });

  it('409 SKIP_NOT_ABANDONED for a pending row', async () => {
    state.rows = [{ status: 'pending' }];
    const res = await reopen();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SKIP_NOT_ABANDONED');
    expect(state.reopenCalls).toEqual([]);
  });

  it('409 when the guarded write loses the race (no snapshot stored)', async () => {
    state.rows = [{ status: 'abandoned' }];
    state.reopenResult = null;
    const res = await reopen();
    expect(res.status).toBe(409);
    expect(state.discordCalls).toHaveLength(0);
  });

  it('400 on missing idempotency key / reason', async () => {
    expect((await reopen({ headers: {} })).status).toBe(400);
    expect((await reopen({ body: {} })).status).toBe(400);
  });
});
