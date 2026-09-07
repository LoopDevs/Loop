import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, UserDoc } from '../../db/types.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getMeHandler, setHomeCurrencyHandler } from '../handler.js';

/**
 * User profile handlers, run against the real in-memory document
 * store. Identity resolution goes through the REAL
 * `resolveLoopAuthenticatedUser` (A2-550/A2-551: the context's
 * cryptographically-verified `auth.userId`, then a `users` lookup) —
 * so these tests seed the store and supply a LoopAuthContext fixture,
 * mirroring what `requireAuth` puts on the context in production.
 */
function makeCtx(auth: LoopAuthContext | undefined, body?: unknown): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    req: {
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    },
    get: (k: string) => store.get(k),
    json: (responseBody: unknown, status?: number) =>
      new Response(JSON.stringify(responseBody), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const UID = '00000000-0000-4000-8000-000000000001';

const loopAuth: LoopAuthContext = { kind: 'loop', userId: UID } as LoopAuthContext;
const ctxAuth = { kind: 'ctx', token: 'ctx-bearer' } as unknown as LoopAuthContext;

async function seedUser(overrides: Partial<UserDoc> = {}): Promise<UserDoc> {
  const now = new Date('2026-04-01T00:00:00Z');
  const doc: UserDoc = {
    id: UID,
    ctxUserId: 'ctx-123',
    email: 'a@b.com',
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await db.collection('users').insertOne(doc);
  return doc;
}

async function seedOrder(overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  const now = new Date();
  const doc: OrderDoc = {
    id: overrides.id ?? 'o-1',
    userId: UID,
    merchantId: 'm-1',
    faceValueMinor: 1000,
    currency: 'USD',
    chargeMinor: 950,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: null,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: now,
    failedAt: null,
    ...overrides,
  };
  await db.collection('orders').insertOne(doc);
  return doc;
}

beforeEach(() => {
  __resetDbForTests();
});

describe('getMeHandler', () => {
  it('401 when no auth is on the context', async () => {
    const res = await getMeHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('resolves a Loop-native bearer via the users collection and returns the profile view', async () => {
    await seedUser();
    const res = await getMeHandler(makeCtx(loopAuth));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ id: UID, email: 'a@b.com', homeCurrency: 'USD' });
  });

  it('401 when the Loop bearer resolves no user row (deleted or unknown)', async () => {
    const res = await getMeHandler(makeCtx(loopAuth));
    expect(res.status).toBe(401);
  });

  it('A2-550: rejects CTX pass-through bearers with 401 (forged-sub attack)', async () => {
    await seedUser();
    const res = await getMeHandler(makeCtx(ctxAuth));
    expect(res.status).toBe(401);
  });

  it('omits ctxUserId, tokenVersion, and timestamps from the view — only id/email/homeCurrency surface', async () => {
    await seedUser();
    const res = await getMeHandler(makeCtx(loopAuth));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'homeCurrency', 'id']);
    expect(JSON.stringify(body)).not.toContain('ctx-123');
  });
});

describe('setHomeCurrencyHandler', () => {
  it('400 when body is malformed (no currency)', async () => {
    await seedUser();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, {}));
    expect(res.status).toBe(400);
  });

  it('400 when currency is not in the enum', async () => {
    await seedUser();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'JPY' }));
    expect(res.status).toBe(400);
  });

  it('400 when the body is not JSON at all', async () => {
    await seedUser();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, undefined));
    expect(res.status).toBe(400);
  });

  it('401 when no auth on the context', async () => {
    const res = await setHomeCurrencyHandler(makeCtx(undefined, { currency: 'GBP' }));
    expect(res.status).toBe(401);
  });

  it('401 for a CTX pass-through bearer', async () => {
    await seedUser();
    const res = await setHomeCurrencyHandler(makeCtx(ctxAuth, { currency: 'GBP' }));
    expect(res.status).toBe(401);
  });

  it('happy path — order-less user gets homeCurrency written and returns the new view', async () => {
    await seedUser({ homeCurrency: 'USD' });
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
    // Persisted, not just echoed.
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('GBP');
  });

  it('409 HOME_CURRENCY_LOCKED once the user has any order (first-time-only write)', async () => {
    await seedUser({ homeCurrency: 'USD' });
    await seedOrder();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('HOME_CURRENCY_LOCKED');
    // The write did NOT land.
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('USD');
  });

  it('short-circuits when the requested currency already matches — no write, even with orders present', async () => {
    const seeded = await seedUser({ homeCurrency: 'GBP' });
    // An order exists, but the no-op path must still succeed so the
    // client can call this unconditionally from onboarding.
    await seedOrder();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
    // No-op: updatedAt untouched proves no write happened.
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.updatedAt).toEqual(seeded.updatedAt);
  });

  it('404 when the user row disappears between resolve and update (race with deletion)', async () => {
    await seedUser({ homeCurrency: 'USD' });
    // Simulate the race: the resolve sees the user, then the doc
    // vanishes before the guarded update runs.
    const users = db.collection('users');
    const realUpdateOne = users.updateOne.bind(users);
    vi.spyOn(users, 'updateOne').mockImplementationOnce(async (filter, update, options) => {
      await users.deleteMany({ id: UID });
      return realUpdateOne(filter, update, options);
    });
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(404);
  });
});
