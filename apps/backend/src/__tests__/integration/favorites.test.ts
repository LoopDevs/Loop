/**
 * Caller-scoped favourites integration tests on real postgres.
 *
 * Covers the three `/api/users/me/favorites` handlers:
 *
 *   - GET    /api/users/me/favorites
 *   - POST   /api/users/me/favorites
 *   - DELETE /api/users/me/favorites/:merchantId
 *
 * Real concerns the unit-shaped mocks would miss:
 *   - The `(user_id, merchant_id)` PK semantics — concurrent adds at
 *     the boundary have to land exactly one row.
 *   - The per-user 50-favourite cap, enforced inside a txn so two
 *     concurrent adds at index 49→50 can't both win.
 *   - The DESC-by-created_at index covers the only read shape.
 *   - Scope: caller A cannot read or remove caller B's favourites.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Discord notifiers fire-and-forget; mocking keeps test logs quiet.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return { ...actual, notifyAdminAudit: noop, notifyAdminBulkRead: noop };
});

// Catalog stub — handler reads `getMerchants().merchantsById` to
// validate the merchant exists. Seeding the in-memory store with a
// few known merchants is faster than spinning up the upstream sync.
const merchantState = vi.hoisted(() => ({
  knownIds: new Set<string>(['amazon', 'starbucks', 'home-depot', 'target', 'best-buy']),
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({
    merchants: [...merchantState.knownIds].map((id) => ({
      id,
      name: id,
      enabled: true,
    })),
    merchantsById: new Map(
      [...merchantState.knownIds].map((id) => [id, { id, name: id, enabled: true }]),
    ),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

import { db } from '../../db/client.js';
import { users, userFavoriteMerchants } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app } from '../../app.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

interface SeededUser {
  userId: string;
  email: string;
  bearer: string;
}

async function seedUser(email: string): Promise<SeededUser> {
  const user = await findOrCreateUserByEmail(email);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
  return { userId: user.id, email: user.email, bearer: access.token };
}

describeIf('user favourites — real postgres', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('GET /favorites returns an empty list before any are added', async () => {
    const me = await seedUser('fav-empty@test.local');
    const res = await app.request('http://localhost/api/users/me/favorites', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { favorites: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.favorites).toEqual([]);
  });

  it('POST /favorites adds a row and is idempotent on re-add', async () => {
    const me = await seedUser('fav-add@test.local');
    const url = 'http://localhost/api/users/me/favorites';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${me.bearer}`,
    };
    const body = JSON.stringify({ merchantId: 'amazon' });

    const first = await app.request(url, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { merchantId: string; added: boolean };
    expect(firstBody.added).toBe(true);
    expect(firstBody.merchantId).toBe('amazon');

    const second = await app.request(url, { method: 'POST', headers, body });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { added: boolean };
    expect(secondBody.added).toBe(false);

    // Exactly one row landed, not two.
    const rows = await db
      .select()
      .from(userFavoriteMerchants)
      .where(eq(userFavoriteMerchants.userId, me.userId));
    expect(rows).toHaveLength(1);
  });

  it('POST /favorites returns 404 MERCHANT_NOT_FOUND for an unknown id', async () => {
    const me = await seedUser('fav-unknown@test.local');
    const res = await app.request('http://localhost/api/users/me/favorites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${me.bearer}`,
      },
      body: JSON.stringify({ merchantId: 'no-such-merchant' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MERCHANT_NOT_FOUND');
  });

  it('POST /favorites returns 400 on invalid body', async () => {
    const me = await seedUser('fav-badbody@test.local');
    const res = await app.request('http://localhost/api/users/me/favorites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${me.bearer}`,
      },
      body: JSON.stringify({ merchantId: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /favorites returns rows newest-first joined to the catalog', async () => {
    const me = await seedUser('fav-list@test.local');
    // Manually seed three rows with monotonically increasing
    // timestamps so the DESC ordering is unambiguous.
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    for (const [i, id] of (['amazon', 'starbucks', 'target'] as const).entries()) {
      await db.insert(userFavoriteMerchants).values({
        userId: me.userId,
        merchantId: id,
        createdAt: new Date(base + i * 1000),
      });
    }

    const res = await app.request('http://localhost/api/users/me/favorites', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorites: Array<{ merchantId: string; merchant: { id: string } | null }>;
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.favorites.map((f) => f.merchantId)).toEqual(['target', 'starbucks', 'amazon']);
    expect(body.favorites[0]?.merchant?.id).toBe('target');
  });

  it('GET /favorites surfaces merchant: null for catalog-evicted ids without crashing', async () => {
    const me = await seedUser('fav-evicted@test.local');
    // Insert a favourite for a merchant the catalog stub doesn't know.
    await db.insert(userFavoriteMerchants).values({
      userId: me.userId,
      merchantId: 'evicted-merchant',
    });

    const res = await app.request('http://localhost/api/users/me/favorites', {
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorites: Array<{ merchantId: string; merchant: unknown }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.favorites[0]?.merchantId).toBe('evicted-merchant');
    expect(body.favorites[0]?.merchant).toBeNull();
  });

  it('DELETE /favorites/:id removes a row and is idempotent on re-delete', async () => {
    const me = await seedUser('fav-del@test.local');
    await db.insert(userFavoriteMerchants).values({
      userId: me.userId,
      merchantId: 'starbucks',
    });

    const first = await app.request('http://localhost/api/users/me/favorites/starbucks', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { removed: boolean };
    expect(firstBody.removed).toBe(true);

    const second = await app.request('http://localhost/api/users/me/favorites/starbucks', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { removed: boolean };
    expect(secondBody.removed).toBe(false);

    const rows = await db
      .select()
      .from(userFavoriteMerchants)
      .where(eq(userFavoriteMerchants.userId, me.userId));
    expect(rows).toHaveLength(0);
  });

  it('caller A cannot read or remove caller B favourites (scope)', async () => {
    const a = await seedUser('fav-scope-a@test.local');
    const b = await seedUser('fav-scope-b@test.local');
    await db.insert(userFavoriteMerchants).values({
      userId: b.userId,
      merchantId: 'amazon',
    });

    // A's list is empty.
    const aList = await app.request('http://localhost/api/users/me/favorites', {
      headers: { Authorization: `Bearer ${a.bearer}` },
    });
    const aBody = (await aList.json()) as { total: number };
    expect(aBody.total).toBe(0);

    // A's DELETE on B's favourite is a no-op (returns removed: false),
    // and B's row survives.
    const aDelete = await app.request('http://localhost/api/users/me/favorites/amazon', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${a.bearer}` },
    });
    expect(aDelete.status).toBe(200);
    const aDeleteBody = (await aDelete.json()) as { removed: boolean };
    expect(aDeleteBody.removed).toBe(false);

    const bRows = await db
      .select()
      .from(userFavoriteMerchants)
      .where(eq(userFavoriteMerchants.userId, b.userId));
    expect(bRows).toHaveLength(1);
  });

  it('refuses 50th add with FAVORITES_LIMIT_EXCEEDED', async () => {
    const me = await seedUser('fav-cap@test.local');
    // Seed 50 rows directly.
    for (let i = 0; i < 50; i++) {
      await db.insert(userFavoriteMerchants).values({
        userId: me.userId,
        merchantId: `seeded-${i}`,
      });
    }
    const res = await app.request('http://localhost/api/users/me/favorites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${me.bearer}`,
      },
      body: JSON.stringify({ merchantId: 'amazon' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FAVORITES_LIMIT_EXCEEDED');
  });

  it('401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/favorites');
    expect(res.status).toBe(401);
  });
});
