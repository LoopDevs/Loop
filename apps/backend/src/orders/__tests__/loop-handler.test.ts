import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import type * as SchemaModule from '../../db/schema.js';

vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_JWT_SIGNING_KEY'] ??= 'unit-test-loop-jwt-signing-key-32ch!';
  process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
    'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
});

const createOrderMock = vi.fn();
const findOrderByIdempotencyKeyMock = vi.fn();
const getMerchantsMock = vi.fn();

const { IdempotentOrderConflictError, InsufficientCreditError } = vi.hoisted(() => {
  class IdempotentOrderConflictError extends Error {
    readonly existing: unknown;
    constructor(existing: unknown) {
      super('replay');
      this.name = 'IdempotentOrderConflictError';
      this.existing = existing;
    }
  }
  class InsufficientCreditError extends Error {
    constructor() {
      super('balance');
      this.name = 'InsufficientCreditError';
    }
  }
  return { IdempotentOrderConflictError, InsufficientCreditError };
});

vi.mock('../repo.js', () => ({
  createOrder: (args: unknown) => createOrderMock(args),
  findOrderByIdempotencyKey: (userId: string, key: string) =>
    findOrderByIdempotencyKeyMock(userId, key),
  IdempotentOrderConflictError,
  InsufficientCreditError,
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
// cross-currency FX or the CF-19 "no rate yet" path swap in
// `fxState.impl` (set per-test, reset in beforeEach).
const { fxState, CurrencyRateUnavailableError } = vi.hoisted(() => {
  class CurrencyRateUnavailableError extends Error {
    readonly currency: string;
    constructor(currency: string) {
      super(`no rate for ${currency}`);
      this.name = 'CurrencyRateUnavailableError';
      this.currency = currency;
    }
  }
  const fxState: { impl: (amount: bigint, from: string, to: string) => Promise<bigint> } = {
    impl: async (amount: bigint) => amount,
  };
  return { fxState, CurrencyRateUnavailableError };
});
vi.mock('../../payments/price-feed.js', () => ({
  convertMinorUnits: vi.fn((amount: bigint, from: string, to: string) =>
    fxState.impl(amount, from, to),
  ),
  CurrencyRateUnavailableError,
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

// Wallet layer (ADR 036 OQ3) — the credit-retirement gate checks
// `getWalletProvider() !== null`. Toggleable per-test; default off.
const { walletProviderState } = vi.hoisted(() => ({
  walletProviderState: { on: false },
}));
vi.mock('../../wallet/provider.js', () => ({
  getWalletProvider: () => (walletProviderState.on ? ({} as never) : null),
}));

import { loopCreateOrderHandler, validateMerchantDenomination } from '../loop-handler.js';

interface FakeCtx {
  store: Map<string, unknown>;
  body: unknown;
  ctx: Context;
}

function makeCtx(opts: {
  auth?: LoopAuthContext | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}): FakeCtx {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  const headers: Record<string, string> = {};
  if (opts.headers !== undefined) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return {
    store,
    body: opts.body,
    ctx: {
      req: {
        json: async () => {
          if (opts.body === '__throw__') throw new Error('bad json');
          return opts.body;
        },
        header: (name: string) => headers[name.toLowerCase()],
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
  findOrderByIdempotencyKeyMock.mockReset();
  findOrderByIdempotencyKeyMock.mockResolvedValue(null);
  getMerchantsMock.mockReset();
  balanceState.rows = [];
  payoutAssetState.issuer = null;
  fxState.impl = async (amount: bigint) => amount;
  walletProviderState.on = false;
  userState.user = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'GBP',
    ctxUserId: null,
    walletProvisioning: 'none',
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

  it('credit path — 400 CREDIT_METHOD_RETIRED for wallet-activated users (ADR 036 OQ3)', async () => {
    // ADR 036 OQ3 (resolved 2026-06-12): once the wallet layer is on
    // and the user's wallet is `activated`, the balance IS the tokens
    // — spending happens as token redemption, so the inline mirror
    // debit ('credit') is retired. createOrder must NOT be called.
    walletProviderState.on = true;
    userState.user = {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
      walletProvisioning: 'activated',
    };
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
    expect(body.code).toBe('CREDIT_METHOD_RETIRED');
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

  it('rejects with 400 when the request currency is not an orderable currency', async () => {
    // JPY is neither a home nor an ADR-035 extended market currency —
    // it's catalogue-only / unrouted, so the order path declines it.
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
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/Unsupported gift-card currency/);
  });

  // ── CF-19 / ADR 035: extended-market order path ─────────────────────
  it('accepts an extended-market currency (AED) and FX-pins the charge to the home currency', async () => {
    // Catalog currency AED, user home GBP. FX mock converts AED→GBP.
    fxState.impl = async (_amount: bigint, from: string, to: string) => {
      expect(from).toBe('AED');
      expect(to).toBe('GBP');
      return 2723n; // pretend FX result, in GBP pence
    };
    createOrderMock.mockResolvedValueOnce({
      id: 'order-uuid',
      userId: 'user-uuid',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'AED',
      chargeMinor: 2723n,
      chargeCurrency: 'GBP',
      paymentMethod: 'xlm',
      paymentMemo: 'MEMO-ABCDEFGHIJKLMNOP',
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'AED',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    // Catalog currency persisted as AED; charge currency is the home (GBP).
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'AED', chargeCurrency: 'GBP', chargeMinor: 2723n }),
    );
  });

  it('returns 503 CURRENCY_NOT_AVAILABLE when the rates service has no rate for the extended currency yet', async () => {
    // CF-19: the market is SEO-promoted but the external rates service
    // doesn't serve INR yet. Fail gracefully ("coming soon") — never
    // create the order, never 500, never a wrong charge.
    fxState.impl = async () => {
      throw new CurrencyRateUnavailableError('INR');
    };
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'INR',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('CURRENCY_NOT_AVAILABLE');
    expect(body.message).toMatch(/coming soon/i);
    // The order must NOT have been created on the no-rate path.
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('a generic FX feed outage stays 503 SERVICE_UNAVAILABLE (not CURRENCY_NOT_AVAILABLE)', async () => {
    fxState.impl = async () => {
      throw new Error('FX feed 500');
    };
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
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('credit path — still allowed for not-yet-activated users (ADR 036 migration window)', async () => {
    // Mirror balance accrued pre-wallet has no emitted tokens, so the
    // inline mirror debit is the only coherent spend path — 'credit'
    // keeps working until provisioning completes.
    walletProviderState.on = true;
    userState.user = {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
      walletProvisioning: 'wallet_created',
    };
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      userId: 'user-uuid',
      merchantId: 'm1',
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
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: 'credit' }),
    );
  });

  it('credit path — still allowed when the wallet layer is off, even if activated', async () => {
    // LOOP_WALLET_PROVIDER='' deployments have no redemption rail to
    // point users at; the retirement gate requires BOTH the provider
    // and an activated wallet (ADR 036 OQ3).
    walletProviderState.on = false;
    userState.user = {
      id: 'user-uuid',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      ctxUserId: null,
      walletProvisioning: 'activated',
    };
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      userId: 'user-uuid',
      merchantId: 'm1',
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
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: 'credit' }),
    );
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

  // A2-2003: Idempotency-Key support on POST /api/orders/loop
  describe('Idempotency-Key (A2-2003)', () => {
    const VALID_KEY = '0123456789abcdef-loop-order-idempotency-key';

    it('400 when Idempotency-Key is too short', async () => {
      const { ctx } = makeCtx({
        auth: LOOP_AUTH,
        headers: { 'Idempotency-Key': 'short' },
        body: {
          merchantId: 'm1',
          amountMinor: 10_000,
          currency: 'GBP',
          paymentMethod: 'xlm',
        },
      });
      const res = await loopCreateOrderHandler(ctx);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.message).toMatch(/Idempotency-Key/i);
      expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('400 when Idempotency-Key exceeds the 128-char ceiling', async () => {
      const tooLong = 'x'.repeat(129);
      const { ctx } = makeCtx({
        auth: LOOP_AUTH,
        headers: { 'Idempotency-Key': tooLong },
        body: {
          merchantId: 'm1',
          amountMinor: 10_000,
          currency: 'GBP',
          paymentMethod: 'xlm',
        },
      });
      const res = await loopCreateOrderHandler(ctx);
      expect(res.status).toBe(400);
      expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('replays the prior order when (userId, key) already maps to one', async () => {
      const prior = {
        id: 'prior-order-id',
        userId: 'user-uuid',
        merchantId: 'm1',
        faceValueMinor: 7_500n,
        currency: 'GBP',
        chargeMinor: 7_500n,
        chargeCurrency: 'GBP',
        paymentMethod: 'xlm',
        paymentMemo: 'PRIORMEMO',
      };
      findOrderByIdempotencyKeyMock.mockResolvedValueOnce(prior);
      const { ctx } = makeCtx({
        auth: LOOP_AUTH,
        headers: { 'Idempotency-Key': VALID_KEY },
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
        payment: { memo: string; amountMinor: string };
      };
      // Replay returns the PRIOR order's data — not the freshly-built
      // FX result. Memo + amount come from the stored row.
      expect(body.orderId).toBe('prior-order-id');
      expect(body.payment.memo).toBe('PRIORMEMO');
      expect(body.payment.amountMinor).toBe('7500');
      // Crucially: createOrder is NOT called on replay, so no second
      // row + (for credit-funded orders) no second debit lands.
      expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('passes the key through to createOrder when no prior order exists', async () => {
      findOrderByIdempotencyKeyMock.mockResolvedValueOnce(null);
      const { ctx } = makeCtx({
        auth: LOOP_AUTH,
        headers: { 'Idempotency-Key': VALID_KEY },
        body: {
          merchantId: 'm1',
          amountMinor: 10_000,
          currency: 'GBP',
          paymentMethod: 'xlm',
        },
      });
      const res = await loopCreateOrderHandler(ctx);
      expect(res.status).toBe(200);
      expect(createOrderMock).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: VALID_KEY }),
      );
    });

    it('replays the existing order when createOrder hits a unique-violation race', async () => {
      // Lookup says no prior — second caller raced past the lookup
      // before the first caller's INSERT committed. Now createOrder
      // throws IdempotentOrderConflictError carrying the prior row.
      findOrderByIdempotencyKeyMock.mockResolvedValueOnce(null);
      const winner = {
        id: 'winner-order-id',
        userId: 'user-uuid',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        chargeMinor: 10_000n,
        chargeCurrency: 'GBP',
        paymentMethod: 'xlm',
        paymentMemo: 'WINNERMEMO',
      };
      createOrderMock.mockRejectedValueOnce(new IdempotentOrderConflictError(winner));
      const { ctx } = makeCtx({
        auth: LOOP_AUTH,
        headers: { 'Idempotency-Key': VALID_KEY },
        body: {
          merchantId: 'm1',
          amountMinor: 10_000,
          currency: 'GBP',
          paymentMethod: 'xlm',
        },
      });
      const res = await loopCreateOrderHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orderId: string; payment: { memo: string } };
      expect(body.orderId).toBe('winner-order-id');
      expect(body.payment.memo).toBe('WINNERMEMO');
    });

    it('header is optional — request without it succeeds without lookup', async () => {
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
      expect(findOrderByIdempotencyKeyMock).not.toHaveBeenCalled();
      // createOrder receives no idempotencyKey on this path.
      expect(createOrderMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      );
    });
  });
});

describe('loopCreateOrderHandler — A4-017 global face-value cap', () => {
  it('rejects amounts above the 50,000-major hard ceiling', async () => {
    const fake = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: '5000001', // $50,000.01 — one cent past the cap
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(fake.ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/exceeds maximum order value/);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('accepts amounts at the cap when merchant denominations allow', async () => {
    getMerchantsMock.mockReturnValue({
      merchantsById: new Map([
        [
          'm1',
          {
            id: 'm1',
            name: 'Target',
            enabled: true,
            denominations: { type: 'min-max', denominations: [], currency: 'GBP', max: 50000 },
          },
        ],
      ]),
    });
    const fake = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: '5000000', // $50,000.00 — exactly at the cap
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(fake.ctx);
    expect(res.status).toBe(200);
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ faceValueMinor: 5_000_000n }),
    );
  });
});

describe('validateMerchantDenomination (A4-103)', () => {
  it('passes when merchant has no denomination contract', () => {
    expect(validateMerchantDenomination(1000n, 'GBP', undefined)).toBeNull();
  });

  it('rejects mismatched currency', () => {
    expect(
      validateMerchantDenomination(1000n, 'EUR', {
        type: 'min-max',
        denominations: [],
        currency: 'GBP',
        min: 5,
        max: 100,
      }),
    ).toMatch(/currency must be GBP/);
  });

  it('rejects under min on min-max', () => {
    expect(
      validateMerchantDenomination(400n, 'GBP', {
        type: 'min-max',
        denominations: [],
        currency: 'GBP',
        min: 5,
        max: 100,
      }),
    ).toMatch(/below merchant minimum/);
  });

  it('rejects over max on min-max', () => {
    expect(
      validateMerchantDenomination(15_000n, 'GBP', {
        type: 'min-max',
        denominations: [],
        currency: 'GBP',
        min: 5,
        max: 100,
      }),
    ).toMatch(/above merchant maximum/);
  });

  it('passes inside min-max range', () => {
    expect(
      validateMerchantDenomination(2_500n, 'GBP', {
        type: 'min-max',
        denominations: [],
        currency: 'GBP',
        min: 5,
        max: 100,
      }),
    ).toBeNull();
  });

  it('rejects amount not in fixed denominations', () => {
    expect(
      validateMerchantDenomination(2_500n, 'USD', {
        type: 'fixed',
        denominations: ['10', '50', '100'],
        currency: 'USD',
      }),
    ).toMatch(/fixed denominations/);
  });

  it('passes amount matching fixed denomination (decimal)', () => {
    expect(
      validateMerchantDenomination(2_500n, 'USD', {
        type: 'fixed',
        denominations: ['25.00', '50'],
        currency: 'USD',
      }),
    ).toBeNull();
  });
});
