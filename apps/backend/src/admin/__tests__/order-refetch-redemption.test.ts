/**
 * One-shot redemption re-fetch action (ADR 037 §4.3). The
 * machinery itself (eligibility, persist guards, attempt bumps) is
 * covered in orders/__tests__/redemption-backfill.test.ts — this
 * file covers the handler edge: envelope, outcome → status mapping,
 * and the no-snapshot-on-failure contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  outcome: null as null | Record<string, unknown>,
  refetchCalls: [] as string[],
  snapshotStored: false,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../orders/redemption-backfill.js', () => ({
  refetchOrderRedemption: vi.fn(async (orderId: string) => {
    state.refetchCalls.push(orderId);
    return state.outcome;
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
      state.snapshotStored = true;
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

import { adminRefetchRedemptionHandler } from '../order-refetch-redemption.js';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'support@loop.test' };
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  orderId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'orderId' ? (args.orderId ?? ORDER_ID) : undefined),
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

const refetch = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
  adminRefetchRedemptionHandler(
    makeCtx({
      headers: { 'idempotency-key': validKey },
      body: { reason: 'CTX delayed issuance, re-driving' },
      ...over,
    }),
  );

beforeEach(() => {
  state.outcome = { kind: 'recovered', attempts: 11, hasCode: true, hasPin: false, hasUrl: false };
  state.refetchCalls = [];
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminRefetchRedemptionHandler', () => {
  it('200 recovered: presence flags only, never the codes', async () => {
    const res = await refetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({
      orderId: ORDER_ID,
      recovered: true,
      hasCode: true,
      hasPin: false,
      hasUrl: false,
      attempts: 11,
    });
    expect(JSON.stringify(body)).not.toContain('redeemCode');
    expect(state.refetchCalls).toEqual([ORDER_ID]);
    expect(state.discordCalls).toHaveLength(1);
  });

  it('200 still_empty: recovered false, attempts bumped', async () => {
    state.outcome = {
      kind: 'still_empty',
      attempts: 12,
      hasCode: false,
      hasPin: false,
      hasUrl: false,
    };
    const res = await refetch();
    const body = (await res.json()) as Record<string, any>;
    expect(body.result.recovered).toBe(false);
    expect(body.result.attempts).toBe(12);
  });

  it('404 / 409 / 503 escape the guard WITHOUT storing a snapshot', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ kind: 'order_not_found' }, 404, 'NOT_FOUND'],
      [{ kind: 'not_eligible', reason: 'already_present' }, 409, 'REDEMPTION_NOT_REFETCHABLE'],
      [{ kind: 'pool_unavailable' }, 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [outcome, status, code] of cases) {
      state.outcome = outcome;
      state.snapshotStored = false;
      const res = await refetch();
      expect(res.status).toBe(status);
      expect(((await res.json()) as { code: string }).code).toBe(code);
      expect(state.snapshotStored).toBe(false);
      expect(state.discordCalls).toHaveLength(0);
    }
  });

  it('400 on bad orderId / missing key / missing reason', async () => {
    expect((await refetch({ orderId: 'nope' })).status).toBe(400);
    expect((await refetch({ headers: {} })).status).toBe(400);
    expect((await refetch({ body: {} })).status).toBe(400);
    expect(state.refetchCalls).toEqual([]);
  });

  it('replays return the snapshot and mark the audit as replayed', async () => {
    state.priorSnapshot = {
      status: 200,
      body: { result: { orderId: ORDER_ID }, audit: { replayed: true } },
    };
    const res = await refetch();
    expect(res.status).toBe(200);
    expect(state.refetchCalls).toEqual([]); // no second CTX round-trip
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });
});
