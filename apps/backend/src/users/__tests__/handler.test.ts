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

const updateCtxStableCurrencyMock = vi.hoisted(() => vi.fn());
const updateCtxCashbackDestinationMock = vi.hoisted(() => vi.fn());
const updateCtxCountryMock = vi.hoisted(() => vi.fn());
vi.mock('../../ctx/user-roles.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  updateCtxStableCurrency: updateCtxStableCurrencyMock,
  updateCtxCashbackDestination: updateCtxCashbackDestinationMock,
  updateCtxCountry: updateCtxCountryMock,
}));
const loopCompanyState = vi.hoisted(() => ({ countries: null as string[] | null }));
vi.mock('../../ctx/startup.js', () => ({
  peekLoopCompany: () =>
    loopCompanyState.countries === null ? null : { countries: loopCompanyState.countries },
}));

import { CtxUserRolesError } from '../../ctx/user-roles.js';
import {
  getMeHandler,
  setCashbackDestinationHandler,
  setCountryHandler,
  setHomeCurrencyHandler,
} from '../handler.js';

// User profile handlers — A2-550, A2-551
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
    isAdmin: false,
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
    mirrorSyncedAt: null,
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
  updateCtxStableCurrencyMock.mockReset();
  updateCtxStableCurrencyMock.mockResolvedValue({ isAdmin: false, homeCurrency: 'GBP' });
  updateCtxCashbackDestinationMock.mockReset();
  updateCtxCashbackDestinationMock.mockResolvedValue({
    isAdmin: false,
    homeCurrency: 'GBP',
    cashbackDestination: 'savings',
    country: null,
  });
  updateCtxCountryMock.mockReset();
  updateCtxCountryMock.mockResolvedValue({
    isAdmin: false,
    homeCurrency: null,
    cashbackDestination: 'account',
    country: 'GB',
  });
  loopCompanyState.countries = null;
});

describe('setCountryHandler', () => {
  it('400 when the body carries no two-letter country', async () => {
    await seedUser();
    expect((await setCountryHandler(makeCtx(loopAuth, {}))).status).toBe(400);
    expect((await setCountryHandler(makeCtx(loopAuth, { country: 'GBR' }))).status).toBe(400);
    expect(updateCtxCountryMock).not.toHaveBeenCalled();
  });

  it('400 when the country is not one the operator offers', async () => {
    loopCompanyState.countries = ['US', 'GB'];
    await seedUser();
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'PT' }));
    expect(res.status).toBe(400);
    expect(updateCtxCountryMock).not.toHaveBeenCalled();
  });

  it('401 when no auth on the context', async () => {
    const res = await setCountryHandler(makeCtx(undefined, { country: 'GB' }));
    expect(res.status).toBe(401);
  });

  it('writes the country to CTX first, then mirrors it and returns the view', async () => {
    loopCompanyState.countries = ['US', 'GB'];
    await seedUser();
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'gb' }));
    expect(res.status).toBe(200);
    expect(updateCtxCountryMock).toHaveBeenCalledWith('ctx-123', 'GB');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['country']).toBe('GB');
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.country).toBe('GB');
  });

  it('adopts the held stable CTX derives from the country as the home currency', async () => {
    updateCtxCountryMock.mockResolvedValue({
      isAdmin: false,
      homeCurrency: 'GBP',
      cashbackDestination: 'account',
      country: 'GB',
    });
    await seedUser({ homeCurrency: 'USD' });
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'GB' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
  });

  it('no-op when the country is unchanged', async () => {
    await seedUser({ country: 'GB' });
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'GB' }));
    expect(res.status).toBe(200);
    expect(updateCtxCountryMock).not.toHaveBeenCalled();
  });

  it('503 and no local write when CTX is unavailable', async () => {
    await seedUser();
    updateCtxCountryMock.mockRejectedValueOnce(new CtxUserRolesError('down', 503));
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'GB' }));
    expect(res.status).toBe(503);
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.country).toBeUndefined();
  });

  it('400 when CTX rejects the country', async () => {
    await seedUser();
    updateCtxCountryMock.mockRejectedValueOnce(new CtxUserRolesError('bad', 400));
    const res = await setCountryHandler(makeCtx(loopAuth, { country: 'GB' }));
    expect(res.status).toBe(400);
  });
});

describe('setCashbackDestinationHandler', () => {
  it('400 when the destination is not account or savings', async () => {
    await seedUser();
    const res = await setCashbackDestinationHandler(makeCtx(loopAuth, { destination: 'mattress' }));
    expect(res.status).toBe(400);
  });

  it('401 when no auth on the context', async () => {
    const res = await setCashbackDestinationHandler(makeCtx(undefined, { destination: 'savings' }));
    expect(res.status).toBe(401);
  });

  it('writes the destination at CTX first, then mirrors it locally and returns the view', async () => {
    await seedUser();
    const res = await setCashbackDestinationHandler(makeCtx(loopAuth, { destination: 'savings' }));
    expect(res.status).toBe(200);
    expect(updateCtxCashbackDestinationMock).toHaveBeenCalledWith('ctx-123', 'savings');
    const body = (await res.json()) as { cashbackDestination: string };
    expect(body.cashbackDestination).toBe('savings');
    const row = await db.collection('users').findOne({ id: UID });
    expect(row?.cashbackDestination).toBe('savings');
  });

  it('is a no-op when the destination is unchanged', async () => {
    await seedUser();
    const res = await setCashbackDestinationHandler(makeCtx(loopAuth, { destination: 'account' }));
    expect(res.status).toBe(200);
    expect(updateCtxCashbackDestinationMock).not.toHaveBeenCalled();
  });

  it('503 and no local write when CTX is unavailable', async () => {
    await seedUser();
    updateCtxCashbackDestinationMock.mockRejectedValueOnce(new CtxUserRolesError('down', 503));
    const res = await setCashbackDestinationHandler(makeCtx(loopAuth, { destination: 'savings' }));
    expect(res.status).toBe(503);
    const row = await db.collection('users').findOne({ id: UID });
    expect(row?.cashbackDestination).toBeUndefined();
  });
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
    expect(body).toEqual({
      id: UID,
      email: 'a@b.com',
      homeCurrency: 'USD',
      staffRole: null,
      isAdmin: false,
      cashbackDestination: 'account',
      country: null,
    });
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

  it('omits ctxUserId, tokenVersion, and timestamps from the view — only the profile + staff tier surface', async () => {
    await seedUser();
    const res = await getMeHandler(makeCtx(loopAuth));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'cashbackDestination',
      'country',
      'email',
      'homeCurrency',
      'id',
      'isAdmin',
      'staffRole',
    ]);
    expect(JSON.stringify(body)).not.toContain('ctx-123');
  });

  // ADR 037: web admin shell gates navigation on staffRole
  it('reports the staff tier from a staff_roles row', async () => {
    await seedUser();
    await db.collection('staff_roles').insertOne({
      userId: UID,
      role: 'support',
      grantedAt: new Date(),
      grantedByUserId: null,
      reason: null,
    });
    const res = await getMeHandler(makeCtx(loopAuth));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['staffRole']).toBe('support');
    expect(body['isAdmin']).toBe(false);
  });

  it('falls back to the users.isAdmin CTX-role mirror when there is no row', async () => {
    await seedUser({ isAdmin: true });
    const res = await getMeHandler(makeCtx(loopAuth));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['staffRole']).toBe('admin');
    expect(body['isAdmin']).toBe(true);
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

  it('happy path — order-less user gets the CTX stableCurrency and homeCurrency written and returns the new view', async () => {
    await seedUser({ homeCurrency: 'USD' });
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
    expect(updateCtxStableCurrencyMock).toHaveBeenCalledWith('ctx-123', 'GBP');
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('GBP');
  });

  it('writes locally only while the user has no CTX mapping yet', async () => {
    await seedUser({ homeCurrency: 'USD', ctxUserId: null });
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    expect(updateCtxStableCurrencyMock).not.toHaveBeenCalled();
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('GBP');
  });

  it('503 and no local write when the CTX stableCurrency update fails', async () => {
    await seedUser({ homeCurrency: 'USD' });
    updateCtxStableCurrencyMock.mockRejectedValue(new CtxUserRolesError('ctx down', 503));
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('SUPPLIER_UNAVAILABLE');
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('USD');
  });

  it('400 when CTX rejects the stable for the company', async () => {
    await seedUser({ homeCurrency: 'USD' });
    updateCtxStableCurrencyMock.mockRejectedValue(new CtxUserRolesError('not supported', 400));
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(400);
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('USD');
  });

  it('409 HOME_CURRENCY_LOCKED once the user has any order (first-time-only write)', async () => {
    await seedUser({ homeCurrency: 'USD' });
    await seedOrder();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('HOME_CURRENCY_LOCKED');
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.homeCurrency).toBe('USD');
  });

  it('short-circuits when the requested currency already matches — no write, even with orders present', async () => {
    const seeded = await seedUser({ homeCurrency: 'GBP' });
    await seedOrder();
    const res = await setHomeCurrencyHandler(makeCtx(loopAuth, { currency: 'GBP' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['homeCurrency']).toBe('GBP');
    expect(updateCtxStableCurrencyMock).not.toHaveBeenCalled();
    const stored = await db.collection('users').findOne({ id: UID });
    expect(stored?.updatedAt).toEqual(seeded.updatedAt);
  });

  it('404 when the user row disappears between resolve and update (race with deletion)', async () => {
    await seedUser({ homeCurrency: 'USD' });
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
