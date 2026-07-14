/**
 * BK-pctcheck + NS-16 — DB-tier CHECK constraints on `orders`
 * (real postgres, migration 0068).
 *
 * Migration 0068 adds two defence-in-depth CHECK constraints:
 *
 *   - `orders_percentages_non_negative` (BK-pctcheck): the pinned
 *     cashback-split percentages (`wholesale_pct` / `user_cashback_pct` /
 *     `loop_margin_pct`) must each be `>= 0`. A negative pct inverts the
 *     split math; the sibling `merchant_cashback_configs` (the source
 *     these are pinned FROM, ADR 011) already carries the same guard.
 *
 *   - `orders_face_value_positive` (NS-16): `face_value_minor` must be
 *     `> 0` — a zero-value gift card is not a real order, and both create
 *     paths already forbid zero at the edge.
 *
 * These live in the DB, so this drives the REAL constraints against real
 * postgres. We assert BOTH that the bad rows are REJECTED with a
 * check-constraint violation (SQLSTATE 23514) AND that a legitimate order
 * still commits — including the two documented legitimate ZERO cases the
 * constraints deliberately DON'T reject (a 100%-cashback charge_minor=0
 * order, and zero split-minor columns).
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, orders } from '../../db/schema.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(email: string): Promise<string> {
  const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
  return row!.id;
}

/**
 * A fully-valid `orders` insert payload for `userId`. Overrides are
 * shallow-merged so each test tweaks exactly the one column under test
 * and leaves every OTHER constraint satisfied — a non-vacuous rejection
 * proves the tweaked column's guard fired, not some unrelated check.
 */
function baseOrder(
  userId: string,
  overrides: Partial<typeof orders.$inferInsert> = {},
): typeof orders.$inferInsert {
  return {
    userId,
    merchantId: 'amazon',
    faceValueMinor: 5000n,
    currency: 'USD',
    chargeMinor: 5000n,
    chargeCurrency: 'USD',
    paymentMethod: 'usdc',
    // orders_payment_memo_coherence: non-'credit' methods need a memo.
    paymentMemo: `test-memo-${crypto.randomUUID()}`,
    wholesalePct: '70.00',
    userCashbackPct: '5.00',
    loopMarginPct: '25.00',
    wholesaleMinor: 3500n,
    userCashbackMinor: 250n,
    loopMarginMinor: 1250n,
    state: 'pending_payment',
    ...overrides,
  };
}

/**
 * Drives an insert expected to be rejected by a DB CHECK and returns the
 * error message + SQLSTATE. drizzle wraps the postgres-js error in a
 * DrizzleQueryError whose top-level `.message` is a generic "Failed
 * query…"; the constraint name + code live on the `.cause` chain — walk
 * it so the assertion sees the real violation.
 */
async function expectDbReject(p: Promise<unknown>): Promise<{ text: string; code: string }> {
  try {
    await p;
  } catch (e) {
    let text = '';
    let code = '';
    let cur: unknown = e;
    while (cur !== null && cur !== undefined) {
      const node = cur as { message?: string; code?: string; constraint?: string; cause?: unknown };
      if (typeof node.message === 'string') text += ` ${node.message}`;
      if (typeof node.constraint === 'string') text += ` ${node.constraint}`;
      if (typeof node.code === 'string' && code === '') code = node.code;
      cur = node.cause;
    }
    return { text, code };
  }
  throw new Error('expected the insert to be rejected by the DB CHECK, but it resolved');
}

describeIf('BK-pctcheck + NS-16 orders CHECK constraints (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  // ── BK-pctcheck: orders_percentages_non_negative ──────────────────────
  it('rejects an order with a negative wholesale_pct (23514)', async () => {
    const userId = await seedUser(`pct-neg-w-${crypto.randomUUID()}@test.local`);
    const rejection = await expectDbReject(
      db.insert(orders).values(baseOrder(userId, { wholesalePct: '-5.00' })),
    );
    expect(rejection.code).toBe('23514'); // check_violation
    expect(rejection.text).toMatch(/orders_percentages_non_negative/);

    const rows = await db.select({ id: orders.id }).from(orders);
    expect(rows).toHaveLength(0);
  });

  it('rejects an order with a negative user_cashback_pct (23514)', async () => {
    const userId = await seedUser(`pct-neg-u-${crypto.randomUUID()}@test.local`);
    const rejection = await expectDbReject(
      db.insert(orders).values(baseOrder(userId, { userCashbackPct: '-1.00' })),
    );
    expect(rejection.code).toBe('23514');
    expect(rejection.text).toMatch(/orders_percentages_non_negative/);
  });

  it('rejects an order with a negative loop_margin_pct (23514)', async () => {
    const userId = await seedUser(`pct-neg-m-${crypto.randomUUID()}@test.local`);
    const rejection = await expectDbReject(
      db.insert(orders).values(baseOrder(userId, { loopMarginPct: '-0.01' })),
    );
    expect(rejection.code).toBe('23514');
    expect(rejection.text).toMatch(/orders_percentages_non_negative/);
  });

  it('still admits an all-zero pct split (legitimate, must NOT be rejected)', async () => {
    // A zero-cashback / zero-margin merchant with a 100%-wholesale split
    // (or the env fallback) is legitimate: `>= 0`, not `> 0`.
    const userId = await seedUser(`pct-zero-${crypto.randomUUID()}@test.local`);
    const [row] = await db
      .insert(orders)
      .values(
        baseOrder(userId, {
          wholesalePct: '0.00',
          userCashbackPct: '0.00',
          loopMarginPct: '0.00',
          wholesaleMinor: 5000n,
          userCashbackMinor: 0n,
          loopMarginMinor: 0n,
        }),
      )
      .returning({ id: orders.id });
    expect(row?.id).toBeTruthy();
  });

  // ── NS-16: orders_face_value_positive ─────────────────────────────────
  it('rejects a zero-value order (face_value_minor = 0) (23514)', async () => {
    const userId = await seedUser(`fv-zero-${crypto.randomUUID()}@test.local`);
    const rejection = await expectDbReject(
      db.insert(orders).values(
        baseOrder(userId, {
          faceValueMinor: 0n,
          chargeMinor: 0n,
          wholesaleMinor: 0n,
          userCashbackMinor: 0n,
          loopMarginMinor: 0n,
        }),
      ),
    );
    expect(rejection.code).toBe('23514'); // check_violation
    expect(rejection.text).toMatch(/orders_face_value_positive/);

    const rows = await db.select({ id: orders.id }).from(orders);
    expect(rows).toHaveLength(0);
  });

  it('still admits a charge_minor = 0 order (100%-cashback Tranche-1 discount, must NOT be rejected)', async () => {
    // face_value_minor stays > 0 (the gift card is worth something); the
    // user is charged 0 because the whole face value was delivered as an
    // instant discount (repo.ts, LOOP_PHASE_1_ONLY at 100% cashback).
    // This is exactly why NS-16 tightens face_value_minor ONLY, not
    // charge_minor.
    const userId = await seedUser(`charge-zero-${crypto.randomUUID()}@test.local`);
    const [row] = await db
      .insert(orders)
      .values(
        baseOrder(userId, {
          faceValueMinor: 5000n,
          chargeMinor: 0n,
          userCashbackPct: '0.00', // zeroed on the row in Tranche-1 mode
          userCashbackMinor: 0n,
        }),
      )
      .returning({ id: orders.id });
    expect(row?.id).toBeTruthy();
  });

  // ── Sanity: a fully-valid order commits ───────────────────────────────
  it('commits a fully-valid order', async () => {
    const userId = await seedUser(`valid-${crypto.randomUUID()}@test.local`);
    const [row] = await db
      .insert(orders)
      .values(baseOrder(userId))
      .returning({ id: orders.id, faceValueMinor: orders.faceValueMinor });
    expect(row?.id).toBeTruthy();

    const stored = await db
      .select({ fv: orders.faceValueMinor })
      .from(orders)
      .where(eq(orders.id, row!.id));
    expect(stored[0]?.fv).toBe(5000n);
  });
});
