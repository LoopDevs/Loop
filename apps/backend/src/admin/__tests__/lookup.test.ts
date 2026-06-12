/**
 * Reverse lookup (ADR 037 §4.1) — shape classification + one
 * index-backed query per shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  /** Results returned per successive awaited select chain. */
  results: [] as unknown[][],
  queries: 0,
}));

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain['then'] = (resolve: (rows: unknown[]) => void) => {
    const rows = state.results[state.queries] ?? [];
    state.queries++;
    return Promise.resolve(resolve(rows));
  };
  return chain;
}

vi.mock('../../db/client.js', () => ({
  db: { select: () => makeChain() },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminLookupHandler } from '../lookup.js';

const ORDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const MEMO = 'ABCDEFGHIJKLMNOPQRST'; // 20 base32 chars
const ADDRESS = `G${'A'.repeat(55)}`;

function makeCtx(q: string | undefined): Context {
  return {
    req: { query: (k: string) => (k === 'q' ? q : undefined) },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.results = [];
  state.queries = 0;
});

describe('adminLookupHandler', () => {
  it('400 when q is missing, oversized, or matches no shape', async () => {
    expect((await adminLookupHandler(makeCtx(undefined))).status).toBe(400);
    expect((await adminLookupHandler(makeCtx('x'.repeat(65)))).status).toBe(400);
    expect((await adminLookupHandler(makeCtx('hello world'))).status).toBe(400);
    expect((await adminLookupHandler(makeCtx('abcdefghijklmnopqrst'))).status).toBe(400); // lowercase ≠ memo
    expect(state.queries).toBe(0); // shape rejection never queries
  });

  it('uuid → order lookup', async () => {
    state.results = [[{ id: ORDER_ID, userId: USER_ID }]];
    const res = await adminLookupHandler(makeCtx(ORDER_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'order', userId: USER_ID, orderId: ORDER_ID });
    expect(state.queries).toBe(1);
  });

  it('uuid with no order → 404', async () => {
    state.results = [[]];
    expect((await adminLookupHandler(makeCtx(ORDER_ID))).status).toBe(404);
  });

  it('20-char base32 → payment-memo lookup', async () => {
    state.results = [[{ id: ORDER_ID, userId: USER_ID }]];
    const res = await adminLookupHandler(makeCtx(MEMO));
    expect(await res.json()).toEqual({ kind: 'payment_memo', userId: USER_ID, orderId: ORDER_ID });
  });

  it('stellar address → wallet_address first', async () => {
    state.results = [[{ id: USER_ID }]];
    const res = await adminLookupHandler(makeCtx(ADDRESS));
    expect(await res.json()).toEqual({ kind: 'stellar_address', userId: USER_ID });
    expect(state.queries).toBe(1);
  });

  it('stellar address → legacy stellar_address fallback', async () => {
    state.results = [[], [{ id: USER_ID }]];
    const res = await adminLookupHandler(makeCtx(ADDRESS));
    expect(await res.json()).toEqual({ kind: 'stellar_address', userId: USER_ID });
    expect(state.queries).toBe(2);
  });

  it('stellar address with no owner → 404', async () => {
    state.results = [[], []];
    expect((await adminLookupHandler(makeCtx(ADDRESS))).status).toBe(404);
  });
});
