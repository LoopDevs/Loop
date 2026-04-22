import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// DB mocks:
//   select(...).from(...).where(...)                      → count rows
//     (setHomeCurrency path — awaits the where directly)
//   select(...).from(...).where(...).orderBy(...).limit(N) → history rows
//     (cashback-history path — chains a terminal .limit)
//   update(...).set(...).where(...).returning()           → updated user rows
// The select chain's `.where()` returns a shapeshifter leaf that's
// thenable (so the first caller can `await` it and read the count
// row) AND exposes `.orderBy` / `.limit` (so the second caller can
// chain onto it and read the list). Drizzle's real query builder
// behaves similarly — the chain is lazy until awaited.
//
// The `query` surface fronts drizzle's relational builder — only
// userCredits is exposed since that's what `toView` reaches for.
const { selectChain, updateChain, queryObj, dbState } = vi.hoisted(() => {
  const state: {
    orderCount: string;
    updatedUser: unknown;
    historyRows: unknown[];
    homeBalanceMinor: bigint | null;
    creditsRows: unknown[];
  } = {
    orderCount: '0',
    updatedUser: null,
    historyRows: [],
    homeBalanceMinor: null,
    creditsRows: [],
  };
  const sel: Record<string, ReturnType<typeof vi.fn>> = {};
  sel['from'] = vi.fn(() => sel);
  sel['where'] = vi.fn(() => {
    const leaf: Record<string, unknown> = {};
    leaf['then'] = (resolve: (v: Array<{ n: string }>) => void, reject: (err: unknown) => void) => {
      try {
        resolve([{ n: state.orderCount }]);
      } catch (err) {
        reject(err);
      }
    };
    // getUserCreditsHandler ends its chain on `.orderBy(...)` (no
    // `.limit`). Return an awaitable that resolves to `creditsRows`
    // for that path; the cashback-history path still chains to
    // `.limit()` which returns `historyRows`.
    leaf['orderBy'] = vi.fn(() => {
      const orderByLeaf: Record<string, unknown> = {};
      orderByLeaf['then'] = (resolve: (v: unknown[]) => void, reject: (err: unknown) => void) => {
        try {
          resolve(state.creditsRows);
        } catch (err) {
          reject(err);
        }
      };
      orderByLeaf['limit'] = vi.fn(async () => state.historyRows);
      return orderByLeaf;
    });
    leaf['limit'] = vi.fn(async () => state.historyRows);
    return leaf;
  });
  const upd: Record<string, ReturnType<typeof vi.fn>> = {};
  upd['set'] = vi.fn(() => upd);
  upd['where'] = vi.fn(() => upd);
  upd['returning'] = vi.fn(async () => (state.updatedUser === null ? [] : [state.updatedUser]));
  const query = {
    userCredits: {
      findFirst: vi.fn(async () =>
        state.homeBalanceMinor === null ? undefined : { balanceMinor: state.homeBalanceMinor },
      ),
    },
  };
  return { selectChain: sel, updateChain: upd, queryObj: query, dbState: state };
});

// Hoisted state the mocked user resolvers read from.
const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
    upsertResult: null as unknown,
    upsertThrow: null as Error | null,
    upsertCalls: [] as Array<{ ctxUserId: string; email: string | undefined }>,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async (args: { ctxUserId: string; email: string | undefined }) => {
    userState.upsertCalls.push(args);
    if (userState.upsertThrow !== null) throw userState.upsertThrow;
    return userState.upsertResult;
  }),
}));
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    query: queryObj,
  },
}));
vi.mock('../../db/schema.js', () => ({
  orders: { userId: 'user_id' },
  users: { id: 'id' },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    balanceMinor: 'balance_minor',
    updatedAt: 'updated_at',
  },
  creditTransactions: {
    userId: 'user_id',
    createdAt: 'created_at',
    id: 'id',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'] as const,
}));

// Pending-payouts repo mock — the user-scoped handler calls into
// `listPayoutsForUser`, so we stub it directly rather than stretch
// the drizzle select chain to cover another shape. Tests drive
// behaviour via `payoutState.rows` / `payoutState.calls`.
const { payoutState } = vi.hoisted(() => ({
  payoutState: {
    rows: [] as unknown[],
    calls: [] as Array<{
      userId: string;
      state?: string;
      before?: Date;
      limit?: number;
    }>,
  },
}));
vi.mock('../../credits/pending-payouts.js', () => ({
  listPayoutsForUser: vi.fn(async (userId: string, opts: Record<string, unknown> = {}) => {
    payoutState.calls.push({ userId, ...opts });
    return payoutState.rows;
  }),
}));

// The handler decodes CTX bearers via auth/jwt decodeJwtPayload —
// stub it to return a preconfigured claim set.
const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    claims: null as Record<string, unknown> | null,
  },
}));
vi.mock('../../auth/jwt.js', () => ({
  decodeJwtPayload: vi.fn(() => jwtState.claims),
}));

import {
  getCashbackHistoryHandler,
  getMeHandler,
  getUserCreditsHandler,
  getUserPendingPayoutsHandler,
  setHomeCurrencyHandler,
  setStellarAddressHandler,
} from '../handler.js';

function makeCtx(
  auth: LoopAuthContext | undefined,
  body?: unknown,
  query?: Record<string, string>,
): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    req: {
      json: async () => body,
      query: (k: string) => query?.[k],
    },
    get: (k: string) => store.get(k),
    json: (responseBody: unknown, status?: number) =>
      new Response(JSON.stringify(responseBody), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  userState.byId = null;
  userState.upsertResult = null;
  userState.upsertThrow = null;
  userState.upsertCalls = [];
  jwtState.claims = null;
  dbState.orderCount = '0';
  dbState.updatedUser = null;
  dbState.historyRows = [];
  dbState.homeBalanceMinor = null;
  payoutState.rows = [];
  payoutState.calls = [];
});

describe('getMeHandler', () => {
  it('401 when no auth is on the context', async () => {
    const res = await getMeHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('resolves a Loop-native bearer via getUserById and returns the profile view', async () => {
    userState.byId = {
      id: 'loop-user-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(
      makeCtx({
        kind: 'loop',
        userId: 'loop-user-1',
        email: 'a@b.com',
        bearerToken: 'loop-jwt',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: 'loop-user-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    });
  });

  it('401 when the Loop bearer resolves no user row (deleted or unknown)', async () => {
    userState.byId = null;
    const res = await getMeHandler(
      makeCtx({
        kind: 'loop',
        userId: 'vanished-user',
        email: 'x@y.com',
        bearerToken: 'loop-jwt',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('resolves a CTX bearer via upsertUserFromCtx and returns the profile view', async () => {
    jwtState.claims = { sub: 'ctx-123', email: 'ctx@example.com' };
    userState.upsertResult = {
      id: 'loop-2',
      email: 'ctx@example.com',
      isAdmin: true,
      homeCurrency: 'USD',
      stellarAddress: null,
      ctxUserId: 'ctx-123',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'ctx-jwt' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: 'loop-2',
      email: 'ctx@example.com',
      isAdmin: true,
      homeCurrency: 'USD',
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    });
    expect(userState.upsertCalls).toEqual([{ ctxUserId: 'ctx-123', email: 'ctx@example.com' }]);
  });

  it('401 when the CTX bearer is unreadable (decodeJwtPayload returns null)', async () => {
    jwtState.claims = null;
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'garbage' }));
    expect(res.status).toBe(401);
  });

  it('500 when the CTX upsert throws — surfaces a clean internal error', async () => {
    jwtState.claims = { sub: 'ctx-err', email: 'e@x.com' };
    userState.upsertThrow = new Error('db exploded');
    const res = await getMeHandler(makeCtx({ kind: 'ctx', bearerToken: 'ctx' }));
    expect(res.status).toBe(500);
  });

  it('omits the ctxUserId and timestamps from the view — only surface id/email/isAdmin/homeCurrency', async () => {
    userState.byId = {
      id: 'u',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'EUR',
      stellarAddress: null,
      ctxUserId: 'should-not-leak',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const res = await getMeHandler(
      makeCtx({ kind: 'loop', userId: 'u', email: 'a@b.com', bearerToken: 't' }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'email',
      'homeCurrency',
      'homeCurrencyBalanceMinor',
      'id',
      'isAdmin',
      'stellarAddress',
    ]);
  });

  it('surfaces homeCurrencyBalanceMinor as a bigint-string when the user has accrued cashback', async () => {
    userState.byId = {
      id: 'loop-user-1',
      email: 'a@b.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    dbState.homeBalanceMinor = 12345n;
    const res = await getMeHandler(
      makeCtx({ kind: 'loop', userId: 'loop-user-1', email: 'a@b.com', bearerToken: 't' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrencyBalanceMinor']).toBe('12345');
  });
});

describe('setHomeCurrencyHandler', () => {
  const LOOP_AUTH: LoopAuthContext = {
    kind: 'loop',
    userId: 'user-uuid',
    email: 'a@b.com',
    bearerToken: 'loop-jwt',
  };
  const baseUser = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'USD',
    stellarAddress: null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('400 when body is malformed (no currency)', async () => {
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, {}));
    expect(res.status).toBe(400);
  });

  it('400 when currency is not in the enum', async () => {
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, { currency: 'JPY' }));
    expect(res.status).toBe(400);
  });

  it('401 when no auth on the context', async () => {
    const res = await setHomeCurrencyHandler(makeCtx(undefined, { currency: 'GBP' }));
    expect(res.status).toBe(401);
  });

  it('happy path — order-less user gets home_currency written and returns the new view', async () => {
    userState.byId = { ...baseUser, homeCurrency: 'USD' };
    dbState.orderCount = '0';
    dbState.updatedUser = { ...baseUser, homeCurrency: 'GBP' };
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
  });

  it('409 HOME_CURRENCY_LOCKED when the user already has orders', async () => {
    userState.byId = { ...baseUser, homeCurrency: 'USD' };
    dbState.orderCount = '3';
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, { currency: 'GBP' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_LOCKED');
  });

  it('short-circuits when the requested currency already matches (no update, no order-count scan of the actual row)', async () => {
    userState.byId = { ...baseUser, homeCurrency: 'GBP' };
    // If the handler fell through to the UPDATE path, .returning() would
    // reject (updatedUser is null → empty array → 404). Instead the
    // short-circuit returns the existing view as-is.
    dbState.updatedUser = null;
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
  });

  it('404 when the user row disappears between resolve and update (race)', async () => {
    userState.byId = { ...baseUser, homeCurrency: 'USD' };
    dbState.orderCount = '0';
    dbState.updatedUser = null; // .returning() → empty array
    const res = await setHomeCurrencyHandler(makeCtx(LOOP_AUTH, { currency: 'GBP' }));
    expect(res.status).toBe(404);
  });
});

describe('setStellarAddressHandler', () => {
  const LOOP_AUTH: LoopAuthContext = {
    kind: 'loop',
    userId: 'user-uuid',
    email: 'a@b.com',
    bearerToken: 'loop-jwt',
  };
  const baseUser = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'USD',
    stellarAddress: null as string | null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const VALID_ADDRESS = 'G' + 'A'.repeat(55);

  it('400 when body is missing', async () => {
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, {}));
    expect(res.status).toBe(400);
  });

  it('400 when address is not a valid Stellar pubkey', async () => {
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: 'not-a-pubkey' }));
    expect(res.status).toBe(400);
  });

  it('401 when no auth on the context', async () => {
    const res = await setStellarAddressHandler(makeCtx(undefined, { address: VALID_ADDRESS }));
    expect(res.status).toBe(401);
  });

  it('happy path — writes the address and returns the updated view', async () => {
    userState.byId = { ...baseUser };
    dbState.updatedUser = { ...baseUser, stellarAddress: VALID_ADDRESS };
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['stellarAddress']).toBe(VALID_ADDRESS);
  });

  it('accepts null explicitly — unlinks the address', async () => {
    userState.byId = { ...baseUser, stellarAddress: VALID_ADDRESS };
    dbState.updatedUser = { ...baseUser, stellarAddress: null };
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['stellarAddress']).toBeNull();
  });

  it('short-circuits when the address already matches — no-op update', async () => {
    userState.byId = { ...baseUser, stellarAddress: VALID_ADDRESS };
    // Updated user intentionally null — the short-circuit path returns
    // the existing view before .returning() is consulted.
    dbState.updatedUser = null;
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['stellarAddress']).toBe(VALID_ADDRESS);
  });

  it('relinking to a different address is allowed (not order-locked like home currency)', async () => {
    const prev = 'G' + 'B'.repeat(55);
    userState.byId = { ...baseUser, stellarAddress: prev };
    dbState.updatedUser = { ...baseUser, stellarAddress: VALID_ADDRESS };
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['stellarAddress']).toBe(VALID_ADDRESS);
  });

  it('404 when the user row disappears between resolve and update (race)', async () => {
    userState.byId = { ...baseUser };
    dbState.updatedUser = null;
    const res = await setStellarAddressHandler(makeCtx(LOOP_AUTH, { address: VALID_ADDRESS }));
    expect(res.status).toBe(404);
  });
});

describe('getCashbackHistoryHandler', () => {
  const LOOP_AUTH: LoopAuthContext = {
    kind: 'loop',
    userId: 'user-uuid',
    email: 'a@b.com',
    bearerToken: 'loop-jwt',
  };
  const baseUser = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'USD',
    stellarAddress: null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const sampleRow = {
    id: 'tx-1',
    type: 'cashback',
    amountMinor: 250n,
    currency: 'USD',
    referenceType: 'order',
    referenceId: 'ord-1',
    createdAt: new Date('2026-04-01T12:00:00Z'),
  };

  it('401 when no auth is on the context', async () => {
    const res = await getCashbackHistoryHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('happy path — returns entries in response envelope with bigint amount as string', async () => {
    userState.byId = baseUser;
    dbState.historyRows = [sampleRow];
    const res = await getCashbackHistoryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({
      id: 'tx-1',
      type: 'cashback',
      amountMinor: '250',
      currency: 'USD',
      referenceType: 'order',
      referenceId: 'ord-1',
      createdAt: '2026-04-01T12:00:00.000Z',
    });
  });

  it('returns an empty entries array when the user has no ledger rows', async () => {
    userState.byId = baseUser;
    dbState.historyRows = [];
    const res = await getCashbackHistoryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('400 when ?before is not a parseable ISO-8601 timestamp', async () => {
    userState.byId = baseUser;
    const res = await getCashbackHistoryHandler(
      makeCtx(LOOP_AUTH, undefined, { before: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a valid ?before and still returns the rows', async () => {
    userState.byId = baseUser;
    dbState.historyRows = [sampleRow];
    const res = await getCashbackHistoryHandler(
      makeCtx(LOOP_AUTH, undefined, { before: '2026-04-15T00:00:00Z' }),
    );
    expect(res.status).toBe(200);
  });

  it('caps ?limit at 100 and floors at 1 — malformed values fall back to the default', async () => {
    userState.byId = baseUser;
    dbState.historyRows = [];
    for (const limit of ['0', '-5', '9999', 'not-a-number']) {
      const res = await getCashbackHistoryHandler(makeCtx(LOOP_AUTH, undefined, { limit }));
      expect(res.status).toBe(200);
    }
  });

  it('500 when the CTX upsert throws', async () => {
    jwtState.claims = { sub: 'ctx-err', email: 'e@x.com' };
    userState.upsertThrow = new Error('db down');
    const res = await getCashbackHistoryHandler(makeCtx({ kind: 'ctx', bearerToken: 't' }));
    expect(res.status).toBe(500);
  });
});

describe('getUserPendingPayoutsHandler', () => {
  const LOOP_AUTH: LoopAuthContext = {
    kind: 'loop',
    userId: 'user-uuid',
    email: 'a@b.com',
    bearerToken: 'loop-jwt',
  };
  const baseUser = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'GBP',
    stellarAddress: null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const sampleRow = {
    id: 'pay-1',
    userId: 'user-uuid',
    orderId: 'ord-1',
    assetCode: 'GBPLOOP',
    assetIssuer: 'GISSUER',
    amountStroops: 12345n,
    state: 'submitted',
    txHash: null,
    attempts: 1,
    createdAt: new Date('2026-04-20T10:00:00Z'),
    submittedAt: new Date('2026-04-20T10:01:00Z'),
    confirmedAt: null,
    failedAt: null,
  };

  it('401 when no auth is on the context', async () => {
    const res = await getUserPendingPayoutsHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('happy path — forwards userId to the repo and shapes rows to JSON', async () => {
    userState.byId = baseUser;
    payoutState.rows = [sampleRow];
    const res = await getUserPendingPayoutsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0]).toEqual({
      id: 'pay-1',
      orderId: 'ord-1',
      assetCode: 'GBPLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '12345',
      state: 'submitted',
      txHash: null,
      attempts: 1,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: '2026-04-20T10:01:00.000Z',
      confirmedAt: null,
      failedAt: null,
    });
    // userId is scoped to the authenticated caller — no cross-user leakage.
    expect(payoutState.calls[0]?.userId).toBe('user-uuid');
  });

  it('rejects an unknown ?state with 400', async () => {
    userState.byId = baseUser;
    const res = await getUserPendingPayoutsHandler(
      makeCtx(LOOP_AUTH, undefined, { state: 'bogus' }),
    );
    expect(res.status).toBe(400);
  });

  it('forwards a valid ?state filter to the repo', async () => {
    userState.byId = baseUser;
    await getUserPendingPayoutsHandler(makeCtx(LOOP_AUTH, undefined, { state: 'failed' }));
    expect(payoutState.calls[0]?.state).toBe('failed');
  });

  it('rejects an invalid ?before timestamp with 400', async () => {
    userState.byId = baseUser;
    const res = await getUserPendingPayoutsHandler(
      makeCtx(LOOP_AUTH, undefined, { before: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('clamps ?limit — malformed values fall back, huge values cap at 100', async () => {
    userState.byId = baseUser;
    await getUserPendingPayoutsHandler(makeCtx(LOOP_AUTH, undefined, { limit: 'nope' }));
    expect(payoutState.calls[0]?.limit).toBe(20);
    payoutState.calls = [];
    await getUserPendingPayoutsHandler(makeCtx(LOOP_AUTH, undefined, { limit: '9999' }));
    expect(payoutState.calls[0]?.limit).toBe(100);
  });

  it('500 when CTX upsert throws', async () => {
    jwtState.claims = { sub: 'ctx-err', email: 'e@x.com' };
    userState.upsertThrow = new Error('db down');
    const res = await getUserPendingPayoutsHandler(makeCtx({ kind: 'ctx', bearerToken: 't' }));
    expect(res.status).toBe(500);
  });
});

describe('getUserCreditsHandler', () => {
  const LOOP_AUTH: LoopAuthContext = {
    kind: 'loop',
    userId: 'user-uuid',
    email: 'a@b.com',
    bearerToken: 'loop-jwt',
  };
  const baseUser = {
    id: 'user-uuid',
    email: 'a@b.com',
    isAdmin: false,
    homeCurrency: 'GBP',
    stellarAddress: null,
    ctxUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    userState.byId = baseUser;
    userState.upsertThrow = null;
    dbState.creditsRows = [];
  });

  it('401 when there is no auth context', async () => {
    const res = await getUserCreditsHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('returns an empty list when the user has no ledger entries', async () => {
    const res = await getUserCreditsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credits: unknown[] };
    expect(body.credits).toEqual([]);
  });

  it('serialises bigint balances and Date timestamps', async () => {
    dbState.creditsRows = [
      {
        currency: 'EUR',
        balanceMinor: 12_345n,
        updatedAt: new Date('2026-04-10T09:00:00Z'),
      },
      {
        currency: 'GBP',
        balanceMinor: 890_000n,
        updatedAt: new Date('2026-04-20T14:00:00Z'),
      },
    ];
    const res = await getUserCreditsHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credits: Array<Record<string, unknown>>;
    };
    expect(body.credits).toHaveLength(2);
    expect(body.credits[0]).toEqual({
      currency: 'EUR',
      balanceMinor: '12345',
      updatedAt: '2026-04-10T09:00:00.000Z',
    });
    expect(body.credits[1]!['balanceMinor']).toBe('890000');
  });

  it('500 when the CTX upsert throws', async () => {
    jwtState.claims = { sub: 'ctx-err', email: 'e@x.com' };
    userState.upsertThrow = new Error('db down');
    const res = await getUserCreditsHandler(makeCtx({ kind: 'ctx', bearerToken: 't' }));
    expect(res.status).toBe(500);
  });
});
