// self-serve home-currency change integration tests — A2-552, ADR 052
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, __resetDbForTests } from '../../db/client.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app, __resetRateLimitsForTests } from '../../app.js';

interface SeededUser {
  userId: string;
  email: string;
  bearer: string;
}

async function seedUser(email: string, homeCurrency: 'USD' | 'GBP' | 'EUR'): Promise<SeededUser> {
  const user = await findOrCreateUserByEmail(email);
  await db.collection('users').updateOne({ id: user.id }, { $set: { homeCurrency } });
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
    state: 'fulfilled',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: now,
    failedAt: null,
  });
}

async function postHomeCurrency(
  bearer: string,
  currency: 'USD' | 'GBP' | 'EUR',
): Promise<Response> {
  return app.request('http://localhost/api/users/me/home-currency', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ currency }),
  });
}

describe('self-serve home-currency change — document store', () => {
  beforeEach(() => {
    __resetDbForTests();
    __resetRateLimitsForTests();
  });

  it('allows the change for an order-less user and persists it', async () => {
    const me = await seedUser('hc-zero@test.local', 'USD');

    const res = await postHomeCurrency(me.bearer, 'GBP');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeCurrency: string };
    expect(body.homeCurrency).toBe('GBP');

    const after = await db.collection('users').findOne({ id: me.userId });
    expect(after?.homeCurrency).toBe('GBP');
  });

  it('409 HOME_CURRENCY_LOCKED once the user has placed an order (A2-552)', async () => {
    const me = await seedUser('hc-locked@test.local', 'USD');
    await seedFulfilledOrder(me.userId);

    const res = await postHomeCurrency(me.bearer, 'GBP');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_LOCKED');

    const after = await db.collection('users').findOne({ id: me.userId });
    expect(after?.homeCurrency).toBe('USD');
  });

  it('same-currency request is a no-op success even with an order on file', async () => {
    const me = await seedUser('hc-noop@test.local', 'USD');
    await seedFulfilledOrder(me.userId);

    const res = await postHomeCurrency(me.bearer, 'USD');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeCurrency: string };
    expect(body.homeCurrency).toBe('USD');
  });

  it('401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/home-currency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'GBP' }),
    });
    expect(res.status).toBe(401);
  });
});
