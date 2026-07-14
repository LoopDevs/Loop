/**
 * MNY-01-INV3 — DB-tier conservation fence on the FRESH cashback /
 * interest MINT INSERT paths (real postgres, migration 0067).
 *
 * Migration 0044 fenced INV-3 (minted-net on-chain LOOP <= mirror
 * liability) at the DB boundary, but its INSERT-side trigger WHENed only
 * on `kind='emission'` — a fresh `order_cashback` / `interest_mint`
 * INSERT was trusted to move the mirror in the same app txn "by
 * construction". Migration 0067 adds
 * `pending_payouts_mint_insert_conservation` so those two mint paths are
 * conservation-checked at the DB too, using the SAME
 * `assert_emission_conservation()` function (SQLSTATE 23514
 * `check_violation`). This suite drives the REAL trigger against real
 * postgres: it lives in the DB, not in any pure module.
 *
 * Non-vacuity is proven in-suite: the last test DROPs the trigger, shows
 * the very same unbacked INSERT then COMMITS, and restores the trigger —
 * so the rejections below are the trigger's doing, not a CHECK's.
 * (An independent verifier reconstructing the pre-0067 state — the
 * trigger absent — will see every rejection test flip to a failure,
 * because the unbacked mint would land.)
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import { users, orders, pendingPayouts } from '../../db/schema.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

// Valid Stellar-shaped fixtures: `^[GC][A-Z2-7]{55}$` for the issuer,
// `^G[A-Z2-7]{55}$` for the destination (pending_payouts CHECKs). Built
// from the base32 alphabet so length + charset are correct by
// construction.
const ISSUER = `G${'B'.repeat(55)}`;
const DEST = `G${'C'.repeat(55)}`;
/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

async function seedUser(email: string): Promise<string> {
  const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
  return row!.id;
}

/** A minimal order so an `order_cashback` row can satisfy its order_id FK + kind_shape CHECK. */
async function seedOrder(userId: string): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      userId,
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: 'fulfilled',
    })
    .returning({ id: orders.id });
  return row!.id;
}

/** Insert an `order_cashback` payout row (mirror currency = USD via USDLOOP). */
async function insertCashbackPayout(args: {
  userId: string;
  orderId: string;
  amountStroops: bigint;
}): Promise<unknown> {
  return db.insert(pendingPayouts).values({
    userId: args.userId,
    orderId: args.orderId,
    kind: 'order_cashback',
    assetCode: 'USDLOOP',
    assetIssuer: ISSUER,
    toAddress: DEST,
    amountStroops: args.amountStroops,
    memoText: 'mny-01-inv3 cashback fixture',
  });
}

/** Insert an `interest_mint` payout row (GBPLOOP-only per the asset-pin CHECK; mirror = GBP). */
async function insertInterestPayout(args: {
  userId: string;
  amountStroops: bigint;
}): Promise<unknown> {
  return db.insert(pendingPayouts).values({
    userId: args.userId,
    orderId: null,
    kind: 'interest_mint',
    assetCode: 'GBPLOOP',
    assetIssuer: ISSUER,
    toAddress: DEST,
    amountStroops: args.amountStroops,
    memoText: 'mny-01-inv3 interest fixture',
  });
}

/**
 * Drives a query expected to be rejected by a DB trigger and returns the
 * RAISEd message + SQLSTATE. drizzle wraps the postgres-js error in a
 * DrizzleQueryError whose top-level `.message` is a generic "Failed
 * query…"; the trigger's real message + code live on the `.cause` chain
 * — walk it so the assertion sees the RAISE text. (Mirrors the helper in
 * ledger-immutability.test.ts.)
 */
async function expectDbReject(p: Promise<unknown>): Promise<{ text: string; code: string }> {
  try {
    await p;
  } catch (e) {
    let text = '';
    let code = '';
    let cur: unknown = e;
    while (cur !== null && cur !== undefined) {
      const node = cur as { message?: string; code?: string; cause?: unknown };
      if (typeof node.message === 'string') text += ` ${node.message}`;
      if (typeof node.code === 'string' && code === '') code = node.code;
      cur = node.cause;
    }
    return { text, code };
  }
  throw new Error('expected the query to be rejected by the DB trigger, but it resolved');
}

async function payoutRowCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: pendingPayouts.id })
    .from(pendingPayouts)
    .where(eq(pendingPayouts.userId, userId));
  return rows.length;
}

describeIf('MNY-01-INV3 fresh-mint INSERT conservation (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  // ── order_cashback ────────────────────────────────────────────────

  it('commits a legitimately-backed order_cashback mint (within un-emitted headroom)', async () => {
    const userId = await seedUser(`inv3-cb-ok-${crypto.randomUUID()}@test.local`);
    const orderId = await seedOrder(userId);
    // 5.00 USD mirror liability, backed by a matching ledger row (0066).
    await seedUserCreditsWithBackingLedger(db, { userId, currency: 'USD', balanceMinor: 500n });

    // Mint 1.00 USD of cashback on-chain — well inside the 5.00 headroom.
    await insertCashbackPayout({ userId, orderId, amountStroops: 100n * STROOPS_PER_MINOR });

    expect(await payoutRowCount(userId)).toBe(1);
  });

  it('rejects an UNBACKED order_cashback mint at the DB (INV-3) and lands no row', async () => {
    const userId = await seedUser(`inv3-cb-unbacked-${crypto.randomUUID()}@test.local`);
    const orderId = await seedOrder(userId);
    // No USD mirror balance at all — a rogue writer minting cashback the
    // liability does not back is exactly the unbacked-mint the fence
    // must catch.
    const rejection = await expectDbReject(
      insertCashbackPayout({ userId, orderId, amountStroops: 100n * STROOPS_PER_MINOR }),
    );
    // Distinguish the conservation trigger from a coincidental CHECK
    // failure (both are SQLSTATE 23514): pin the RAISE message too.
    expect(rejection.code).toBe('23514'); // check_violation
    expect(rejection.text).toMatch(/emission_conservation/i);
    expect(rejection.text).toMatch(/un-emitted liability/i);

    expect(await payoutRowCount(userId)).toBe(0);
  });

  it('rejects an order_cashback mint that EXCEEDS un-emitted headroom, but admits one exactly at it', async () => {
    // Backed for exactly 1.00 USD.
    const atUser = await seedUser(`inv3-cb-at-${crypto.randomUUID()}@test.local`);
    const atOrder = await seedOrder(atUser);
    await seedUserCreditsWithBackingLedger(db, {
      userId: atUser,
      currency: 'USD',
      balanceMinor: 100n,
    });
    // Exactly at headroom (100 minor → 10_000_000 stroops) commits — the
    // rejection is strictly `>`, so the boundary is allowed.
    await insertCashbackPayout({
      userId: atUser,
      orderId: atOrder,
      amountStroops: 100n * STROOPS_PER_MINOR,
    });
    expect(await payoutRowCount(atUser)).toBe(1);

    // Same 1.00 USD backing, but a mint of 100.001 minor (one stroop over
    // a whole minor past headroom) is rejected — proving the fence checks
    // the AMOUNT against headroom arithmetic, not merely "a balance exists".
    const overUser = await seedUser(`inv3-cb-over-${crypto.randomUUID()}@test.local`);
    const overOrder = await seedOrder(overUser);
    await seedUserCreditsWithBackingLedger(db, {
      userId: overUser,
      currency: 'USD',
      balanceMinor: 100n,
    });
    const rejection = await expectDbReject(
      insertCashbackPayout({
        userId: overUser,
        orderId: overOrder,
        amountStroops: 100n * STROOPS_PER_MINOR + 100n,
      }),
    );
    expect(rejection.code).toBe('23514');
    expect(rejection.text).toMatch(/emission_conservation/i);
    expect(await payoutRowCount(overUser)).toBe(0);
  });

  // ── interest_mint ─────────────────────────────────────────────────

  it('commits a legitimately-backed interest_mint (within un-emitted headroom)', async () => {
    const userId = await seedUser(`inv3-int-ok-${crypto.randomUUID()}@test.local`);
    // 5.00 GBP mirror liability (interest_mint is GBPLOOP-only → GBP).
    await seedUserCreditsWithBackingLedger(db, { userId, currency: 'GBP', balanceMinor: 500n });

    await insertInterestPayout({ userId, amountStroops: 100n * STROOPS_PER_MINOR });

    expect(await payoutRowCount(userId)).toBe(1);
  });

  it('rejects an UNBACKED interest_mint at the DB (INV-3) and lands no row', async () => {
    const userId = await seedUser(`inv3-int-unbacked-${crypto.randomUUID()}@test.local`);
    // No GBP mirror balance backs this nightly mint.
    const rejection = await expectDbReject(
      insertInterestPayout({ userId, amountStroops: 100n * STROOPS_PER_MINOR }),
    );
    expect(rejection.code).toBe('23514'); // check_violation
    expect(rejection.text).toMatch(/emission_conservation/i);
    expect(rejection.text).toMatch(/un-emitted liability/i);

    expect(await payoutRowCount(userId)).toBe(0);
  });

  // ── non-vacuity: the trigger is load-bearing ──────────────────────

  it('is non-vacuous: with the trigger DROPPED the same unbacked mint COMMITS, and is rejected again once restored', async () => {
    const userId = await seedUser(`inv3-nonvacuous-${crypto.randomUUID()}@test.local`);
    const orderId = await seedOrder(userId);
    // No mirror balance → unbacked.

    // Reconstruct the pre-0067 state: drop ONLY the INSERT trigger this
    // migration added (0044's emission trigger + the re-entry trigger
    // stay). Restore it in `finally` so the rest of the file — and any
    // re-run in the same worker — keeps the fence.
    await db.execute(
      sql`DROP TRIGGER IF EXISTS pending_payouts_mint_insert_conservation ON pending_payouts`,
    );
    try {
      // Pre-fix behaviour: the unbacked cashback mint lands (nothing at
      // the DB tier stops it) — this is the very bug MNY-01-INV3 closes.
      await insertCashbackPayout({ userId, orderId, amountStroops: 100n * STROOPS_PER_MINOR });
      expect(await payoutRowCount(userId)).toBe(1);

      // Clear it, restore the trigger, and prove the SAME insert is now
      // rejected — the rejection is the trigger's doing.
      await db.execute(
        sql`DELETE FROM pending_payouts WHERE user_id = ${userId} AND state = 'pending'`,
      );
    } finally {
      await db.execute(sql`
        CREATE TRIGGER pending_payouts_mint_insert_conservation
          BEFORE INSERT ON pending_payouts
          FOR EACH ROW
          WHEN (NEW.kind IN ('order_cashback', 'interest_mint') AND NEW.state != 'failed')
          EXECUTE FUNCTION assert_emission_conservation()
      `);
    }

    const rejection = await expectDbReject(
      insertCashbackPayout({ userId, orderId, amountStroops: 100n * STROOPS_PER_MINOR }),
    );
    expect(rejection.code).toBe('23514');
    expect(rejection.text).toMatch(/emission_conservation/i);
    expect(await payoutRowCount(userId)).toBe(0);
  });
});
