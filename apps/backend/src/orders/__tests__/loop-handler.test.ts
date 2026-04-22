import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import type * as SchemaModule from '../../db/schema.js';

vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
    'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
});

const createOrderMock = vi.fn();
const getMerchantsMock = vi.fn();

vi.mock('../repo.js', () => ({
  createOrder: (args: unknown) => createOrderMock(args),
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => getMerchantsMock(),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock the db client — the handler uses it for the credit balance
// lookup (select/from/where) and the user lookup (query.users.findFirst,
// via getUserById). Both resolve off hoisted state so individual tests
// can stash rows / user profiles before calling the handler.
const { dbChain, balanceState, userState } = vi.hoisted(() => {
  const bState: { rows: unknown[] } = { rows: [] };
  const uState: { user: unknown } = {
    user: {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
    },
  };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  // `.where(...)` both resolves to rows (legacy call sites that await
  // it directly — e.g. `hasSufficientCredit`) AND returns a handle
  // with `.limit(...)` (the first-loop-asset check). Drizzle's real
  // API is a thenable builder that has `.limit()` on it until awaited.
  // Construct the thenable on every `.where` call so tests that
  // mutate `bState.rows` between requests see the fresh value.
  chain['where'] = vi.fn(() => {
    const p = Promise.resolve(bState.rows);
    return Object.assign(p, {
      limit: vi.fn(async () => bState.rows),
    });
  });
  return { dbChain: chain, balanceState: bState, userState: uState };
});
vi.mock('../../db/client.js', () => ({
  db: {
    ...dbChain,
    query: {
      users: {
        findFirst: vi.fn(async () => userState.user),
      },
    },
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    userCredits: {
      userId: 'userId',
      currency: 'currency',
      balanceMinor: 'balanceMinor',
    },
    users: { id: 'id' },
  };
});
// FX conversion — tests don't need a real rate feed; echo the input so
// the handler path exercises the charge_minor = face_value case
// (user.home_currency === request.currency). Tests that exercise
// cross-currency FX mock this with a different implementation.
vi.mock('../../payments/price-feed.js', () => ({
  convertMinorUnits: vi.fn(async (amount: bigint) => amount),
}));
// Payout-asset resolver — loop_asset orders read issuer from here.
const { payoutAssetState } = vi.hoisted(() => ({
  payoutAssetState: {
    issuer: null as string | null,
  },
}));
vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: (currency: 'USD' | 'GBP' | 'EUR') => ({
    code: { USD: 'USDLOOP', GBP: 'GBPLOOP', EUR: 'EURLOOP' }[currency],
    issuer: payoutAssetState.issuer,
  }),
}));

import { loopCreateOrderHandler } from '../loop-handler.js';

interface FakeCtx {
  store: Map<string, unknown>;
  body: unknown;
  ctx: Context;
}

function makeCtx(opts: { auth?: LoopAuthContext | undefined; body?: unknown }): FakeCtx {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    store,
    body: opts.body,
    ctx: {
      req: {
        json: async () => {
          if (opts.body === '__throw__') throw new Error('bad json');
          return opts.body;
        },
      },
      get: (k: string) => store.get(k),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

beforeEach(() => {
  createOrderMock.mockReset();
  getMerchantsMock.mockReset();
  balanceState.rows = [];
  payoutAssetState.issuer = null;
  userState.user = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'GBP',
    ctxUserId: null,
  };
  for (const fn of Object.values(dbChain)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
  getMerchantsMock.mockReturnValue({
    merchantsById: new Map([['m1', { id: 'm1', name: 'Target', enabled: true }]]),
  });
  createOrderMock.mockResolvedValue({
    id: 'order-uuid',
    userId: 'user-uuid',
    merchantId: 'm1',
    faceValueMinor: 10_000n,
    currency: 'GBP',
    chargeMinor: 10_000n,
    chargeCurrency: 'GBP',
    paymentMethod: 'xlm',
    paymentMemo: 'MEMO-ABCDEFGHIJKLMNOP',
  });
  balanceState.rows = [];
});

describe('loopCreateOrderHandler', () => {
  it('401 when auth is missing or not Loop-kind', async () => {
    const { ctx } = makeCtx({ body: {} });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(401);

    const { ctx: ctx2 } = makeCtx({
      auth: { kind: 'ctx', bearerToken: 'ctx' },
      body: {},
    });
    expect((await loopCreateOrderHandler(ctx2)).status).toBe(401);
  });

  it('400 on invalid body', async () => {
    const { ctx } = makeCtx({ auth: LOOP_AUTH, body: { merchantId: 'm1' } });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(400);
  });

  it('400 when merchant is unknown or disabled', async () => {
    getMerchantsMock.mockReturnValue({ merchantsById: new Map() });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'missing',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(400);
  });

  it('creates an xlm order and returns the deposit address + memo', async () => {
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orderId: string;
      payment: { method: string; memo: string; stellarAddress: string; amountMinor: string };
    };
    expect(body.orderId).toBe('order-uuid');
    expect(body.payment.method).toBe('xlm');
    expect(body.payment.memo).toBe('MEMO-ABCDEFGHIJKLMNOP');
    expect(body.payment.stellarAddress).toMatch(/^G[A-Z2-7]{55}$/);
    expect(body.payment.amountMinor).toBe('10000');
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-uuid',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
      }),
    );
  });

  it('upper-cases the currency before passing to the repo', async () => {
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'gbp',
        paymentMethod: 'xlm',
      },
    });
    await loopCreateOrderHandler(ctx);
    expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GBP' }));
  });

  it('credit path — rejects with 400 when balance is insufficient', async () => {
    balanceState.rows = [{ balance: '500' }];
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
      paymentMethod: 'credit',
      paymentMemo: null,
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'credit',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_CREDIT');
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('pins charge_minor via FX when user.home_currency differs from the request currency', async () => {
    // User is a GBP account; they're buying a $50 USD gift card.
    // convertMinorUnits stub returns amount × 0.78 to simulate USD→GBP.
    const priceFeed = await import('../../payments/price-feed.js');
    vi.mocked(priceFeed.convertMinorUnits).mockResolvedValueOnce(3900n); // 5000 × 0.78
    userState.user = {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
    };
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 5_000n,
      currency: 'USD',
      chargeMinor: 3_900n,
      chargeCurrency: 'GBP',
      paymentMethod: 'xlm',
      paymentMemo: 'MEMO-xyz',
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 5_000,
        currency: 'USD',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: { amountMinor: string; currency: string } };
    // The user sees their charge in pence of GBP, not the catalog USD.
    expect(body.payment.amountMinor).toBe('3900');
    expect(body.payment.currency).toBe('GBP');
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        faceValueMinor: 5_000n,
        currency: 'USD',
        chargeMinor: 3_900n,
        chargeCurrency: 'GBP',
      }),
    );
  });

  it('rejects with 503 when the FX feed throws', async () => {
    const priceFeed = await import('../../payments/price-feed.js');
    vi.mocked(priceFeed.convertMinorUnits).mockRejectedValueOnce(new Error('feed 503'));
    userState.user = {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
    };
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 5_000,
        currency: 'USD',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(503);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the auth userId has no matching users row', async () => {
    userState.user = undefined;
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 1_000,
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(401);
  });

  it('rejects with 400 when the request currency is not a supported home currency', async () => {
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'JPY',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/USD, GBP, or EUR/);
  });

  it('credit path — creates order when balance covers the amount', async () => {
    balanceState.rows = [{ balance: '20000' }];
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
      paymentMethod: 'credit',
      paymentMemo: null,
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'credit',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: { method: string } };
    expect(body.payment.method).toBe('credit');
  });

  it('loop_asset path — returns deposit address + memo + asset code + issuer', async () => {
    const issuer = 'GB' + '2'.repeat(55);
    payoutAssetState.issuer = issuer;
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
      paymentMethod: 'loop_asset',
      paymentMemo: 'MEMO-LOOP-123',
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'loop_asset',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payment: {
        method: string;
        stellarAddress: string;
        memo: string;
        amountMinor: string;
        currency: string;
        assetCode: string;
        assetIssuer: string;
      };
    };
    expect(body.payment.method).toBe('loop_asset');
    expect(body.payment.assetCode).toBe('GBPLOOP');
    expect(body.payment.assetIssuer).toBe(issuer);
    expect(body.payment.memo).toBe('MEMO-LOOP-123');
    expect(body.payment.amountMinor).toBe('10000');
    expect(body.payment.currency).toBe('GBP');
  });

  it('loop_asset path — 503 when the matching issuer env var is not set', async () => {
    payoutAssetState.issuer = null;
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
      paymentMethod: 'loop_asset',
      paymentMemo: 'MEMO',
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'loop_asset',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(503);
  });
});

describe('loopCreateOrderHandler — feature flag off', () => {
  it('returns 404 when LOOP_AUTH_NATIVE_ENABLED is false', async () => {
    const prev = process.env['LOOP_AUTH_NATIVE_ENABLED'];
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'false';
    vi.resetModules();
    const fresh = await import('../loop-handler.js');
    const store = new Map<string, unknown>();
    const ctx = {
      req: { json: async () => ({}) },
      get: (k: string) => store.get(k),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
    } as unknown as Context;
    const res = await fresh.loopCreateOrderHandler(ctx);
    expect(res.status).toBe(404);
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = prev;
    vi.resetModules();
  });
});
