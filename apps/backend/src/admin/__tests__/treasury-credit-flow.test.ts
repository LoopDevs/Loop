import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as unknown,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    amountMinor: 'credit_transactions.amount_minor',
    currency: 'credit_transactions.currency',
    createdAt: 'credit_transactions.created_at',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminTreasuryCreditFlowHandler } from '../treasury-credit-flow.js';

function makeCtx(query: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
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
});

describe('adminTreasuryCreditFlowHandler', () => {
  it('defaults to 30 days with no currency filter', async () => {
    const res = await adminTreasuryCreditFlowHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      currency: string | null;
      days: unknown[];
    };
    expect(body.windowDays).toBe(30);
    expect(body.currency).toBeNull();
    expect(body.days).toEqual([]);
  });

  it('clamps ?days to [1, 180]', async () => {
    const below = await adminTreasuryCreditFlowHandler(makeCtx({ days: '0' }));
    expect(((await below.json()) as { windowDays: number }).windowDays).toBe(1);

    const above = await adminTreasuryCreditFlowHandler(makeCtx({ days: '9999' }));
    expect(((await above.json()) as { windowDays: number }).windowDays).toBe(180);
  });

  it('coerces NaN ?days back to default 30', async () => {
    const res = await adminTreasuryCreditFlowHandler(makeCtx({ days: 'nope' }));
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);
  });

  it('accepts lowercase ?currency and normalises to upper', async () => {
    const res = await adminTreasuryCreditFlowHandler(makeCtx({ currency: 'usd' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { currency: string }).currency).toBe('USD');
  });

  it('400 on an unknown ?currency', async () => {
    const res = await adminTreasuryCreditFlowHandler(makeCtx({ currency: 'JPY' }));
    expect(res.status).toBe(400);
  });

  it('maps rows: credited - debited = net, as strings', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        credited_minor: '50000',
        debited_minor: '12000',
      },
      {
        day: new Date('2026-04-21T00:00:00Z'),
        currency: 'GBP',
        credited_minor: 0n,
        debited_minor: 0n,
      },
    ];
    const res = await adminTreasuryCreditFlowHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<Record<string, unknown>>;
    };
    expect(body.days).toEqual([
      {
        day: '2026-04-20',
        currency: 'USD',
        creditedMinor: '50000',
        debitedMinor: '12000',
        netMinor: '38000',
      },
      {
        day: '2026-04-21',
        currency: 'GBP',
        creditedMinor: '0',
        debitedMinor: '0',
        netMinor: '0',
      },
    ]);
  });

  it('preserves bigint precision past 2^53 for net', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        credited_minor: '9007199254740992',
        debited_minor: '1',
      },
    ];
    const res = await adminTreasuryCreditFlowHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<Record<string, string>>;
    };
    expect(body.days[0]!['netMinor']).toBe('9007199254740991');
  });

  it('supports a negative net (debits outpace credits)', async () => {
    state.rows = [
      {
        day: '2026-04-20',
        currency: 'USD',
        credited_minor: '100',
        debited_minor: '400',
      },
    ];
    const res = await adminTreasuryCreditFlowHandler(makeCtx());
    const body = (await res.json()) as {
      days: Array<Record<string, string>>;
    };
    expect(body.days[0]!['netMinor']).toBe('-300');
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          day: '2026-04-22',
          currency: 'USD',
          credited_minor: '1',
          debited_minor: '0',
        },
      ],
    };
    const res = await adminTreasuryCreditFlowHandler(makeCtx({ currency: 'USD' }));
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toHaveLength(1);
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminTreasuryCreditFlowHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
