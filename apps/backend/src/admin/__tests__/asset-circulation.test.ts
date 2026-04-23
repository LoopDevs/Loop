import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  ledgerMinor: 0n as bigint,
  ledgerThrow: null as Error | null,
  horizonStroops: 0n as bigint,
  horizonThrow: null as Error | null,
  issuerFor: {
    USDLOOP: 'GUSDISSUER' as string | null,
    GBPLOOP: null as string | null,
    EURLOOP: 'GEURISSUER' as string | null,
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          if (state.ledgerThrow !== null) throw state.ledgerThrow;
          return [{ total: state.ledgerMinor.toString() }];
        },
      }),
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  userCredits: {
    balanceMinor: 'user_credits.balance_minor',
    currency: 'user_credits.currency',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../payments/horizon-circulation.js', () => ({
  getLoopAssetCirculation: vi.fn(async () => {
    if (state.horizonThrow !== null) throw state.horizonThrow;
    return {
      assetCode: 'USDLOOP',
      issuer: 'GABC',
      stroops: state.horizonStroops,
      asOfMs: 1_700_000_000_000,
    };
  }),
}));

vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: (currency: string) => ({
    code: `${currency}LOOP`,
    issuer:
      currency === 'USD'
        ? state.issuerFor.USDLOOP
        : currency === 'GBP'
          ? state.issuerFor.GBPLOOP
          : state.issuerFor.EURLOOP,
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminAssetCirculationHandler } from '../asset-circulation.js';

function makeCtx(params: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      query: (_k: string) => undefined,
      param: (k: string) => params[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.ledgerMinor = 0n;
  state.ledgerThrow = null;
  state.horizonStroops = 0n;
  state.horizonThrow = null;
  state.issuerFor.USDLOOP = 'GUSDISSUER';
  state.issuerFor.GBPLOOP = null;
  state.issuerFor.EURLOOP = 'GEURISSUER';
});

describe('adminAssetCirculationHandler', () => {
  it('400 when assetCode is missing', async () => {
    const res = await adminAssetCirculationHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when assetCode is not a LOOP asset', async () => {
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'JPYLOOP' }));
    expect(res.status).toBe(400);
  });

  it('normalises lowercase assetCode to upper', async () => {
    state.horizonStroops = 10_000_000n; // 1 USDLOOP issued
    state.ledgerMinor = 100n; // £1.00 owed (100 cents = 10_000_000 stroops)
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'usdloop' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetCode: string };
    expect(body.assetCode).toBe('USDLOOP');
  });

  it('409 when the issuer is not configured (GBPLOOP default here)', async () => {
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'GBPLOOP' }));
    expect(res.status).toBe(409);
  });

  it('500 when the ledger liability query throws', async () => {
    state.ledgerThrow = new Error('db down');
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    expect(res.status).toBe(500);
  });

  it('503 when the Horizon circulation read throws', async () => {
    state.horizonThrow = new Error('horizon down');
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    expect(res.status).toBe(503);
  });

  it('returns zero drift when onChain matches ledger liability', async () => {
    state.ledgerMinor = 15_000n; // $150.00 owed
    state.horizonStroops = 1_500_000_000n; // $150.00 issued (150 * 100 minor * 1e5 stroops)
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    const body = (await res.json()) as {
      onChainStroops: string;
      ledgerLiabilityMinor: string;
      driftStroops: string;
    };
    expect(body.onChainStroops).toBe('1500000000');
    expect(body.ledgerLiabilityMinor).toBe('15000');
    expect(body.driftStroops).toBe('0');
  });

  it('returns positive drift when on-chain exceeds ledger (over-minted)', async () => {
    state.ledgerMinor = 100n; // $1.00 owed
    state.horizonStroops = 20_000_000n; // $2.00 issued
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    const body = (await res.json()) as { driftStroops: string };
    expect(body.driftStroops).toBe('10000000'); // +$1.00 over
  });

  it('returns negative drift when ledger exceeds on-chain (settlement backlog)', async () => {
    state.ledgerMinor = 200n; // $2.00 owed
    state.horizonStroops = 10_000_000n; // $1.00 issued
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    const body = (await res.json()) as { driftStroops: string };
    expect(body.driftStroops).toBe('-10000000');
  });

  it('preserves bigint precision past 2^53', async () => {
    state.ledgerMinor = BigInt('1000000000000');
    state.horizonStroops = BigInt('100000000000000000');
    const res = await adminAssetCirculationHandler(makeCtx({ assetCode: 'USDLOOP' }));
    const body = (await res.json()) as {
      ledgerLiabilityMinor: string;
      onChainStroops: string;
      driftStroops: string;
    };
    expect(body.ledgerLiabilityMinor).toBe('1000000000000');
    expect(body.onChainStroops).toBe('100000000000000000');
    // 100000000000000000 - 1000000000000 * 100000 = 100000000000000000 - 100000000000000000 = 0
    expect(body.driftStroops).toBe('0');
  });
});
