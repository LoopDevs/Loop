/**
 * Self-serve home-currency change integration tests on real postgres
 * (DOM-03).
 *
 * `POST /api/users/me/home-currency` is the onboarding-time region
 * picker. It already refuses the change once the user has placed an
 * order (A2-552 order guard → HOME_CURRENCY_LOCKED). DOM-03 closes the
 * money hole the order guard misses: a user can hold a non-zero
 * `user_credits` balance WITHOUT any order (referral / promo credit,
 * admin credit-adjustment, a prior support-mediated flip). That
 * balance is denominated in the CURRENT home currency; flipping the
 * currency without zeroing it first orphans it — every user surface
 * filters on `charge_currency = user.home_currency`, so the row stays
 * on the ledger but goes invisible, mis-stating money.
 *
 * The ADMIN path (`applyAdminHomeCurrencyChange`) already rejects this
 * with 409 HOME_CURRENCY_HAS_LIVE_BALANCE. These tests assert the
 * self-serve path now enforces the SAME guard with the SAME error, and
 * still allows the happy path (zero balance).
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Discord notifiers fire-and-forget; mock to keep test logs quiet
// (mirrors the sibling integration suites — the self-serve path itself
// does not fan out to Discord, but app boot wires the module).
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return { ...actual, notifyAdminAudit: noop, notifyAdminBulkRead: noop };
});

import { db } from '../../db/client.js';
import { users, userCredits } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken, DEFAULT_ACCESS_TTL_SECONDS } from '../../auth/tokens.js';
import { app, __resetRateLimitsForTests } from '../../app.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

interface SeededUser {
  userId: string;
  email: string;
  bearer: string;
}

async function seedUser(email: string, homeCurrency: 'USD' | 'GBP' | 'EUR'): Promise<SeededUser> {
  const user = await findOrCreateUserByEmail(email);
  await db.update(users).set({ homeCurrency }).where(eq(users.id, user.id));
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    // NS-09: stamp the seeded user's current token_version (0) so
    // requireAuth's revocation check admits the token.
    tv: user.tokenVersion,
  });
  return { userId: user.id, email: user.email, bearer: access.token };
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

describeIf('self-serve home-currency change — real postgres (DOM-03)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
  });

  it('409 HOME_CURRENCY_HAS_LIVE_BALANCE when the (order-less) user holds a non-zero balance in the current currency', async () => {
    const me = await seedUser('dom03-live-balance@test.local', 'USD');
    // A non-zero credit balance in the CURRENT home currency, and no
    // order — the case the A2-552 order guard alone lets through. Backed
    // by a matching opening-balance ledger row in ONE transaction
    // (DAT-01-inv1, migration 0066) so the mirror is consistent; the
    // guard reads only the balance, so the backing row is invisible here.
    await seedUserCreditsWithBackingLedger(db, {
      userId: me.userId,
      currency: 'USD',
      balanceMinor: 4200n,
    });

    const res = await postHomeCurrency(me.bearer, 'GBP');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    // Same error the ADMIN path returns (see admin-writes.test.ts).
    expect(body.code).toBe('HOME_CURRENCY_HAS_LIVE_BALANCE');
    expect(body.message).toContain('4200');

    // Critical: no transition happened — the balance is not orphaned.
    const after = await db.select().from(users).where(eq(users.id, me.userId));
    expect(after[0]?.homeCurrency).toBe('USD');
  });

  it('allows the change when the order-less user has no credit balance', async () => {
    const me = await seedUser('dom03-zero-balance@test.local', 'USD');

    const res = await postHomeCurrency(me.bearer, 'GBP');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeCurrency: string };
    expect(body.homeCurrency).toBe('GBP');

    const after = await db.select().from(users).where(eq(users.id, me.userId));
    expect(after[0]?.homeCurrency).toBe('GBP');
  });

  it('allows the change when the user has a zero-balance row in the current currency', async () => {
    const me = await seedUser('dom03-zero-row@test.local', 'USD');
    // A settled-then-fully-debited balance leaves a zero-balance row.
    // Mirrors the admin path's zero-balance allowance.
    await db.insert(userCredits).values({
      userId: me.userId,
      currency: 'USD',
      balanceMinor: 0n,
    });

    const res = await postHomeCurrency(me.bearer, 'EUR');

    expect(res.status).toBe(200);
    const after = await db.select().from(users).where(eq(users.id, me.userId));
    expect(after[0]?.homeCurrency).toBe('EUR');
  });
});
