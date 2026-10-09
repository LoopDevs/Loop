// self-serve stable-currency change integration tests — A2-552, ADR 052
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const updateCtxStableCurrencyMock = vi.hoisted(() => vi.fn());
vi.mock('../../ctx/user-roles.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  updateCtxStableCurrency: updateCtxStableCurrencyMock,
}));

import { db, __resetDbForTests } from '../../db/client.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app, __resetRateLimitsForTests } from '../../app.js';

interface SeededUser {
  userId: string;
  email: string;
  bearer: string;
}

async function seedUser(email: string, stableCurrency: string): Promise<SeededUser> {
  const user = await findOrCreateUserByEmail(email);
  await db
    .collection('users')
    .updateOne({ id: user.id }, { $set: { stableCurrency, ctxUserId: `ctx-${user.id}` } });
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    // NS-09: stamp the seeded user's current tokenVersion (0) so
    // requireAuth's revocation check admits the token.
    tv: user.tokenVersion,
  });
  return { userId: user.id, email: user.email, bearer: access.token };
}

async function seedFulfilledOrder(userId: string): Promise<void> {
  const now = new Date();
  await db.collection('orders').insertOne({
    id: randomUUID(),
    userId,
    merchantId: 'amazon',
    faceValueMinor: 5000,
    currency: 'USD',
    chargeMinor: 5000,
    chargeCurrency: 'USD',
    userCashbackMinor: 0,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
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
  });
}

async function postStableCurrency(bearer: string, stableCurrency: string): Promise<Response> {
  return app.request('http://localhost/api/users/me/stable-currency', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ stableCurrency }),
  });
}

describe('self-serve stable-currency change — document store', () => {
  beforeEach(() => {
    __resetDbForTests();
    __resetRateLimitsForTests();
    updateCtxStableCurrencyMock.mockReset();
    updateCtxStableCurrencyMock.mockImplementation(async (_ctxUserId: string, stable: string) => ({
      isAdmin: false,
      stableCurrency: stable,
      cashbackDestination: 'account',
      country: null,
    }));
  });

  it("writes the change to CTX for an order-less user and persists CTX's reply", async () => {
    const me = await seedUser('hc-zero@test.local', 'XLM.USDC');

    const res = await postStableCurrency(me.bearer, 'XLM.GBPLOOP');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { stableCurrency: string };
    expect(body.stableCurrency).toBe('XLM.GBPLOOP');
    expect(updateCtxStableCurrencyMock).toHaveBeenCalledWith(`ctx-${me.userId}`, 'XLM.GBPLOOP');

    const after = await db.collection('users').findOne({ id: me.userId });
    expect(after?.stableCurrency).toBe('XLM.GBPLOOP');
  });

  it('409 STABLE_CURRENCY_LOCKED once the user has placed an order (A2-552)', async () => {
    const me = await seedUser('hc-locked@test.local', 'XLM.USDC');
    await seedFulfilledOrder(me.userId);

    const res = await postStableCurrency(me.bearer, 'XLM.GBPLOOP');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STABLE_CURRENCY_LOCKED');
    expect(updateCtxStableCurrencyMock).not.toHaveBeenCalled();

    const after = await db.collection('users').findOne({ id: me.userId });
    expect(after?.stableCurrency).toBe('XLM.USDC');
  });

  it('same-stable request is a no-op success even with an order on file', async () => {
    const me = await seedUser('hc-noop@test.local', 'XLM.USDC');
    await seedFulfilledOrder(me.userId);

    const res = await postStableCurrency(me.bearer, 'XLM.USDC');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { stableCurrency: string };
    expect(body.stableCurrency).toBe('XLM.USDC');
    expect(updateCtxStableCurrencyMock).not.toHaveBeenCalled();
  });

  it('401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/stable-currency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stableCurrency: 'XLM.GBPLOOP' }),
    });
    expect(res.status).toBe(401);
  });
});
