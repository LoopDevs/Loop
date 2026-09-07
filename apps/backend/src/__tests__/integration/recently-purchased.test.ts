/**
 * Caller-scoped recently-purchased integration tests on the real
 * document store.
 *
 * Covers `GET /api/users/me/recently-purchased`:
 *   - Group by merchantId: multiple orders to the same merchant
 *     collapse to one chip ordered by max(createdAt) DESC.
 *   - State filter: only `paid` / `fulfilled` count;
 *     `unpaid` / `rejected` / `expired` are excluded.
 *   - Catalog join: known merchants surface with `merchant` set;
 *     evicted merchants surface with `merchant: null`.
 *   - Limit: default 8, clamped to [1, 20] via `?limit=`.
 *   - Scope: caller A never sees caller B's orders.
 *
 * Runs through the REAL `app` against the ephemeral in-memory store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const merchantState = vi.hoisted(() => ({
  knownIds: new Set<string>(['amazon', 'starbucks', 'home-depot', 'target']),
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({
    merchants: [...merchantState.knownIds].map((id) => ({ id, name: id, enabled: true })),
    merchantsById: new Map(
      [...merchantState.knownIds].map((id) => [id, { id, name: id, enabled: true }]),
    ),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

import { db, __resetDbForTests } from '../../db/client.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app } from '../../app.js';

interface SeededUser {
  userId: string;
  bearer: string;
}

async function seedUser(email: string): Promise<SeededUser> {
  const user = await findOrCreateUserByEmail(email);
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    // NS-09: stamp the seeded user's current token_version (0) so
    // requireAuth's revocation check admits the token.
    tv: user.tokenVersion,
  });
  return { userId: user.id, bearer: access.token };
}

interface SeedOrderArgs {
  userId: string;
  merchantId: string;
  state: 'unpaid' | 'paid' | 'fulfilled' | 'rejected' | 'refunded' | 'expired';
  createdAt?: Date;
}

async function seedOrder(args: SeedOrderArgs): Promise<void> {
  await db.collection('orders').insertOne({
    id: randomUUID(),
    userId: args.userId,
    merchantId: args.merchantId,
    faceValueMinor: 5000,
    currency: 'USD',
    chargeMinor: 5000,
    chargeCurrency: 'USD',
    userCashbackMinor: 250,
    expectedCommissionMinor: null,
    ctxOrderId: null,
    ctxPaymentId: null,
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: args.state,
    failureReason: null,
    idempotencyKey: null,
    createdAt: args.createdAt ?? new Date(),
    fulfilledAt: null,
    failedAt: null,
  });
}

describe('user recently-purchased — document store', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  it('returns an empty list before any orders exist', async () => {
    const me = await seedUser('rp-empty@test.local');
    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: unknown[] };
    expect(body.merchants).toEqual([]);
  });

  it('collapses repeat-merchant orders to one entry ordered by MAX(created_at) DESC', async () => {
    const me = await seedUser('rp-collapse@test.local');
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    // Three Amazon orders, two Starbucks. Most-recent Amazon is older
    // than most-recent Starbucks, so Starbucks ranks first.
    await seedOrder({
      userId: me.userId,
      merchantId: 'amazon',
      state: 'fulfilled',
      createdAt: new Date(base),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'amazon',
      state: 'fulfilled',
      createdAt: new Date(base + 1000),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'amazon',
      state: 'fulfilled',
      createdAt: new Date(base + 2000),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'starbucks',
      state: 'paid',
      createdAt: new Date(base + 3000),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'starbucks',
      state: 'fulfilled',
      createdAt: new Date(base + 4000),
    });

    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchants: Array<{ merchantId: string; orderCount: number }>;
    };
    expect(body.merchants.map((m) => m.merchantId)).toEqual(['starbucks', 'amazon']);
    expect(body.merchants[0]?.orderCount).toBe(2);
    expect(body.merchants[1]?.orderCount).toBe(3);
  });

  it('excludes unpaid, rejected, and expired orders', async () => {
    const me = await seedUser('rp-states@test.local');
    await seedOrder({ userId: me.userId, merchantId: 'amazon', state: 'unpaid' });
    await seedOrder({ userId: me.userId, merchantId: 'starbucks', state: 'rejected' });
    await seedOrder({ userId: me.userId, merchantId: 'home-depot', state: 'expired' });
    await seedOrder({ userId: me.userId, merchantId: 'target', state: 'fulfilled' });

    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const body = (await res.json()) as { merchants: Array<{ merchantId: string }> };
    expect(body.merchants.map((m) => m.merchantId)).toEqual(['target']);
  });

  it('includes the paid state alongside fulfilled', async () => {
    const me = await seedUser('rp-inflight@test.local');
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    await seedOrder({
      userId: me.userId,
      merchantId: 'amazon',
      state: 'paid',
      createdAt: new Date(base),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'starbucks',
      state: 'paid',
      createdAt: new Date(base + 1000),
    });
    await seedOrder({
      userId: me.userId,
      merchantId: 'target',
      state: 'fulfilled',
      createdAt: new Date(base + 2000),
    });

    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const body = (await res.json()) as { merchants: Array<{ merchantId: string }> };
    expect(body.merchants.map((m) => m.merchantId)).toEqual(['target', 'starbucks', 'amazon']);
  });

  it('surfaces merchant: null for catalog-evicted ids without crashing', async () => {
    const me = await seedUser('rp-evicted@test.local');
    await seedOrder({ userId: me.userId, merchantId: 'evicted-merchant', state: 'fulfilled' });

    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchants: Array<{ merchantId: string; merchant: unknown }>;
    };
    expect(body.merchants).toHaveLength(1);
    expect(body.merchants[0]?.merchantId).toBe('evicted-merchant');
    expect(body.merchants[0]?.merchant).toBeNull();
  });

  it('honours ?limit= clamped to [1, 20]', async () => {
    const me = await seedUser('rp-limit@test.local');
    // 4 distinct merchants, fulfilled.
    for (const id of ['amazon', 'starbucks', 'home-depot', 'target']) {
      await seedOrder({ userId: me.userId, merchantId: id, state: 'fulfilled' });
    }

    // limit=2 → 2 rows
    const small = await app.request('http://localhost/api/users/me/recently-purchased?limit=2', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const smallBody = (await small.json()) as { merchants: unknown[] };
    expect(smallBody.merchants).toHaveLength(2);

    // limit=999 → clamped to 20 (well below the 4 we seeded, so all 4)
    const big = await app.request('http://localhost/api/users/me/recently-purchased?limit=999', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const bigBody = (await big.json()) as { merchants: unknown[] };
    expect(bigBody.merchants).toHaveLength(4);

    // limit=NaN → defaults to 8
    const bad = await app.request('http://localhost/api/users/me/recently-purchased?limit=abc', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(bad.status).toBe(200);
  });

  it('caller A does not see caller B orders (scope)', async () => {
    const a = await seedUser('rp-scope-a@test.local');
    const b = await seedUser('rp-scope-b@test.local');
    await seedOrder({ userId: b.userId, merchantId: 'amazon', state: 'fulfilled' });

    const res = await app.request('http://localhost/api/users/me/recently-purchased', {
      headers: { Authorization: `Bearer ${a.bearer}` },
    });
    const body = (await res.json()) as { merchants: unknown[] };
    expect(body.merchants).toEqual([]);
  });

  it('401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/recently-purchased');
    expect(res.status).toBe(401);
  });
});
