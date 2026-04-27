/**
 * Caller-scoped cashback-history integration tests on real postgres.
 *
 * Covers the three `/api/users/me/*` ledger-read handlers (ADR 009 /
 * 015):
 *
 *   - GET /api/users/me/cashback-history
 *   - GET /api/users/me/cashback-history.csv  (no prior coverage)
 *   - GET /api/users/me/credits
 *
 * The unit suite mocks drizzle's query builder, which tests the
 * handler's branch logic but can't catch SQL-level mistakes (wrong
 * `desc()` direction, wrong predicate composition, missing WHERE).
 * This suite drives the handlers through `app.request()` against
 * real postgres + real schema, asserting the wire shape matches
 * what the seed produced.
 *
 * What's mocked: discord (handlers don't use it, but app.ts imports
 * it). Everything else is real.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyAdminAudit: noop,
    notifyAdminBulkRead: noop,
  };
});

import { db } from '../../db/client.js';
import { users, creditTransactions, userCredits } from '../../db/schema.js';
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

describeIf('cashback-history integration — JSON pagination + caller scope', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('returns the caller credit-tx rows DESC by createdAt with default limit 20', async () => {
    const me = await seedUser('history-self@test.local');
    // Insert 25 rows with monotonically increasing createdAt so the
    // DESC ordering is unambiguous. The handler defaults to limit=20
    // so we should see the newest 20.
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 25; i++) {
      // No reference — the partial unique index on
      // (type, reference_type, reference_id) only fires when the
      // reference fields are populated. Pagination test doesn't care
      // about ref_id, so leaving them null keeps the seed simple.
      await db.insert(creditTransactions).values({
        userId: me.userId,
        type: 'cashback',
        amountMinor: BigInt(100 + i),
        currency: 'USD',
        createdAt: new Date(base + i * 1000),
      });
    }

    const res = await app.request('http://localhost/api/users/me/cashback-history', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ amountMinor: string }> };
    expect(body.entries.length).toBe(20);
    // First entry should be the newest (i=24, amount=124).
    expect(body.entries[0]!.amountMinor).toBe('124');
    expect(body.entries[19]!.amountMinor).toBe('105');
  });

  it('?before=<iso> excludes rows AT or AFTER that timestamp', async () => {
    const me = await seedUser('history-before@test.local');
    const cursorTime = new Date('2026-02-01T00:00:00Z');
    // 3 rows BEFORE cursor + 2 rows AT/AFTER cursor.
    await db.insert(creditTransactions).values([
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 10n,
        currency: 'USD',
        createdAt: new Date(cursorTime.getTime() - 3000),
      },
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 20n,
        currency: 'USD',
        createdAt: new Date(cursorTime.getTime() - 2000),
      },
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 30n,
        currency: 'USD',
        createdAt: new Date(cursorTime.getTime() - 1000),
      },
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 40n,
        currency: 'USD',
        createdAt: cursorTime,
      },
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 50n,
        currency: 'USD',
        createdAt: new Date(cursorTime.getTime() + 1000),
      },
    ]);

    const url = new URL('http://localhost/api/users/me/cashback-history');
    url.searchParams.set('before', cursorTime.toISOString());
    const res = await app.request(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const body = (await res.json()) as { entries: Array<{ amountMinor: string }> };
    expect(body.entries.length).toBe(3);
    // DESC by createdAt: 30 (newest before cursor) → 20 → 10.
    expect(body.entries.map((e) => e.amountMinor)).toEqual(['30', '20', '10']);
  });

  it('returns 400 when ?before is unparseable', async () => {
    const me = await seedUser('history-bad-before@test.local');
    const url = new URL('http://localhost/api/users/me/cashback-history');
    url.searchParams.set('before', 'not-a-date');
    const res = await app.request(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('caller-scoping — never returns another user`s ledger rows', async () => {
    const me = await seedUser('history-me@test.local');
    const other = await seedUser('history-other@test.local');
    await db.insert(creditTransactions).values([
      { userId: me.userId, type: 'cashback', amountMinor: 100n, currency: 'USD' },
      { userId: other.userId, type: 'cashback', amountMinor: 999n, currency: 'USD' },
    ]);

    const res = await app.request('http://localhost/api/users/me/cashback-history', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const body = (await res.json()) as { entries: Array<{ amountMinor: string }> };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0]!.amountMinor).toBe('100');
  });

  it('returns 401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/cashback-history', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });
});

describeIf('cashback-history-csv integration — wire shape + escaping', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('returns CSV with the documented header + RFC-4180 escaping', async () => {
    const me = await seedUser('csv-export@test.local');
    // Seed rows including content that needs RFC-4180 escaping —
    // referenceId can't contain a comma directly, but referenceType
    // is a free-text column and we deliberately use a value that
    // would break a naive CSV writer. Schema CHECK on
    // credit_transactions allows arbitrary text in referenceType;
    // the handler trusts it and escapes at serialisation time.
    await db.insert(creditTransactions).values([
      {
        userId: me.userId,
        type: 'cashback',
        amountMinor: 100n,
        currency: 'USD',
        referenceType: 'order',
        referenceId: 'order-123',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        userId: me.userId,
        type: 'spend',
        amountMinor: -50n,
        currency: 'USD',
        // Comma + quote in the referenceType to force RFC-4180
        // double-quoted-with-doubled-quote escaping.
        referenceType: 'admin,"adjustment"',
        referenceId: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    ]);

    const res = await app.request('http://localhost/api/users/me/cashback-history.csv', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('loop-cashback-history.csv');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-result-count')).toBe('2');

    const text = await res.text();
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('Created (UTC),Type,Amount (minor),Currency,Reference type,Reference ID');
    // DESC ordering — newest row first (the spend with the comma).
    expect(lines[1]).toBe('2026-01-03T00:00:00.000Z,spend,-50,USD,"admin,""adjustment""",');
    expect(lines[2]).toBe('2026-01-02T00:00:00.000Z,cashback,100,USD,order,order-123');
  });

  it('returns 401 without a bearer token', async () => {
    const res = await app.request('http://localhost/api/users/me/cashback-history.csv', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });

  it('emits an empty body (just the header) when the user has no ledger', async () => {
    const me = await seedUser('csv-empty@test.local');
    const res = await app.request('http://localhost/api/users/me/cashback-history.csv', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-result-count')).toBe('0');
    const text = await res.text();
    expect(text).toBe('Created (UTC),Type,Amount (minor),Currency,Reference type,Reference ID\r\n');
  });
});

describeIf('user-credits integration — multi-currency caller balance', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('returns the caller`s per-currency balances ordered by currency code', async () => {
    const me = await seedUser('credits-multi@test.local');
    await db.insert(userCredits).values([
      { userId: me.userId, currency: 'USD', balanceMinor: 1000n },
      { userId: me.userId, currency: 'GBP', balanceMinor: 500n },
      { userId: me.userId, currency: 'EUR', balanceMinor: 250n },
    ]);

    const res = await app.request('http://localhost/api/users/me/credits', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credits: Array<{ currency: string; balanceMinor: string }>;
    };
    // Handler sorts by currency code ascending — EUR, GBP, USD.
    expect(body.credits.map((c) => c.currency)).toEqual(['EUR', 'GBP', 'USD']);
    expect(body.credits.find((c) => c.currency === 'USD')?.balanceMinor).toBe('1000');
  });

  it('caller-scoping — never returns another user`s balances', async () => {
    const me = await seedUser('credits-me@test.local');
    const other = await seedUser('credits-other@test.local');
    await db.insert(userCredits).values([
      { userId: me.userId, currency: 'USD', balanceMinor: 100n },
      { userId: other.userId, currency: 'USD', balanceMinor: 9999n },
    ]);

    const res = await app.request('http://localhost/api/users/me/credits', {
      method: 'GET',
      headers: { Authorization: `Bearer ${me.bearer}` },
    });
    const body = (await res.json()) as { credits: Array<{ balanceMinor: string }> };
    expect(body.credits.length).toBe(1);
    expect(body.credits[0]!.balanceMinor).toBe('100');
  });
});
