/**
 * NS-08 — per-account freeze / AML-hold: real-postgres coverage of the
 * ledger + mirror service, the hot-path enforcement read, the two-tier
 * scope semantics, and enforcement at the debit / payout points.
 *
 * The append-only `account_holds` ledger is the source of truth; the
 * denormalized `users.frozen_at` / `frozen_scope` MIRROR is the hot
 * per-debit read the gate branches on. This suite proves, against the
 * live `loop_test` postgres:
 *
 *   - MIRROR SYNC: placeHold sets the mirror (min placed_at + most-
 *     restrictive scope); releaseHold recomputes it (null when the last
 *     live hold clears). Re-freeze at the same scope is a no-op (partial
 *     unique index), not a duplicate row.
 *   - FAIL-CLOSED: the hot read treats a DB error / missing user row as
 *     FROZEN (scope full) — money stays put when the state can't be read.
 *   - SCOPE (ASH decision #1/#2): `debits_only` blocks money OUT but lets
 *     earned payouts flow; `full` additionally holds money IN.
 *   - ENFORCEMENT #5 (authoritative, in-txn): a frozen account's
 *     credit-order spend throws `AccountFrozenError` and rolls the whole
 *     txn back — no order, no debit; unfrozen it commits normally.
 *   - ENTRY GATE (#1-#4 share this helper): `guardAccountNotFrozen`
 *     returns a 403 for a blocked intent, null otherwise.
 *   - PAYOUT DEFER #9: an earned payout to a `full`-frozen wallet is
 *     deferred (left pending), not paid; a `debits_only` hold does NOT
 *     defer it.
 *
 * The RED→GREEN proof (neutralising the mirror read makes the
 * enforcement tests fail) is captured in the PR, not committed — see the
 * `it.skip` note at the bottom.
 *
 * Gated on `LOOP_E2E_DB=1`; run via `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

import { db } from '../../db/client.js';
import {
  users,
  accountHolds,
  orders,
  userCredits,
  creditTransactions,
  pendingPayouts,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  getAccountFreezeState,
  assertAccountNotFrozen,
  isFrozenForIntent,
  AccountFrozenError,
} from '../../fraud/account-freeze.js';
import { guardAccountNotFrozen } from '../../fraud/account-freeze-http.js';
import {
  accountFreezeService,
  AccountHoldAlreadyReleasedError,
  AccountHoldNotFoundError,
} from '../../fraud/account-freeze-service.js';
import {
  insertCreditOrderTxn,
  type CreditOrderBaseValues,
} from '../../orders/repo-credit-order.js';
import { payOne } from '../../payments/payout-worker-pay-one.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

let seq = 0;
async function seedUser(): Promise<string> {
  seq += 1;
  const user = await findOrCreateUserByEmail(`ns08-${Date.now()}-${seq}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  return user.id;
}

async function mirror(
  userId: string,
): Promise<{ frozenAt: Date | null; frozenScope: string | null }> {
  const [row] = await db
    .select({ frozenAt: users.frozenAt, frozenScope: users.frozenScope })
    .from(users)
    .where(eq(users.id, userId));
  return { frozenAt: row?.frozenAt ?? null, frozenScope: row?.frozenScope ?? null };
}

async function liveHoldCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: accountHolds.id })
    .from(accountHolds)
    .where(eq(accountHolds.userId, userId));
  return rows.length;
}

function baseValues(
  userId: string,
  overrides: Partial<CreditOrderBaseValues> = {},
): CreditOrderBaseValues {
  return {
    userId,
    merchantId: 'merchant-ns08-test',
    faceValueMinor: 5000n,
    currency: 'USD',
    chargeMinor: 5000n,
    chargeCurrency: 'USD',
    paymentMethod: 'credit',
    paymentMemo: null,
    wholesalePct: '90.00',
    userCashbackPct: '5.00',
    loopMarginPct: '5.00',
    wholesaleMinor: 4500n,
    userCashbackMinor: 250n,
    loopMarginMinor: 250n,
    idempotencyKey: null,
    ...overrides,
  };
}

describeIf('NS-08 account-freeze — ledger ↔ mirror service (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('placeHold writes a live ledger row AND sets the users.frozen_at/frozen_scope mirror', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();

    expect(await mirror(userId)).toEqual({ frozenAt: null, frozenScope: null });

    const hold = await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'card-testing pattern',
      placedByUserId: adminId,
    });

    expect(hold.releasedAt).toBeNull();
    expect(hold.scope).toBe('debits_only');
    const m = await mirror(userId);
    expect(m.frozenScope).toBe('debits_only');
    expect(m.frozenAt).not.toBeNull();
    expect(m.frozenAt!.getTime()).toBe(hold.placedAt.getTime());
  });

  it('re-freeze at the SAME scope is a no-op (partial unique index) — one live row, mirror unchanged', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const first = await accountFreezeService.placeHold({
      userId,
      scope: 'full',
      reasonCode: 'account_compromise',
      reason: 'ATO confirmed',
      placedByUserId: adminId,
    });
    const second = await accountFreezeService.placeHold({
      userId,
      scope: 'full',
      reasonCode: 'aml_review',
      reason: 'second attempt',
      placedByUserId: adminId,
    });
    expect(second.id).toBe(first.id); // returned the existing live hold
    expect(await liveHoldCount(userId)).toBe(1);
    expect((await mirror(userId)).frozenScope).toBe('full');
  });

  it('two scopes resolve to the MOST RESTRICTIVE mirror; releasing full downgrades to debits_only; releasing both clears', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const debitsHold = await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'chargeback_investigation',
      reason: 'cb wave',
      placedByUserId: adminId,
    });
    const fullHold = await accountFreezeService.placeHold({
      userId,
      scope: 'full',
      reasonCode: 'sanctions_screening',
      reason: 'sanctions hit',
      placedByUserId: adminId,
    });
    // full outranks debits_only.
    expect((await mirror(userId)).frozenScope).toBe('full');

    await accountFreezeService.releaseHold({
      holdId: fullHold.id,
      releaseReason: 'sanctions cleared',
      releasedByUserId: adminId,
    });
    // debits_only hold still live → mirror downgrades, stays frozen.
    expect((await mirror(userId)).frozenScope).toBe('debits_only');

    await accountFreezeService.releaseHold({
      holdId: debitsHold.id,
      releaseReason: 'investigation closed',
      releasedByUserId: adminId,
    });
    // No live holds → mirror fully cleared (both columns null — the
    // mirror-shape CHECK holds).
    expect(await mirror(userId)).toEqual({ frozenAt: null, frozenScope: null });
  });

  it('releaseHold rejects an unknown or already-released hold', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const hold = await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'other',
      reason: 'manual review',
      placedByUserId: adminId,
    });
    await expect(
      accountFreezeService.releaseHold({
        holdId: '00000000-0000-0000-0000-000000000000',
        releaseReason: 'nope',
        releasedByUserId: adminId,
      }),
    ).rejects.toBeInstanceOf(AccountHoldNotFoundError);

    await accountFreezeService.releaseHold({
      holdId: hold.id,
      releaseReason: 'done',
      releasedByUserId: adminId,
    });
    await expect(
      accountFreezeService.releaseHold({
        holdId: hold.id,
        releaseReason: 'again',
        releasedByUserId: adminId,
      }),
    ).rejects.toBeInstanceOf(AccountHoldAlreadyReleasedError);
  });
});

describeIf('NS-08 account-freeze — hot-path read + scope semantics', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('getAccountFreezeState reads the mirror: not-frozen fresh, frozen after placeHold', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    expect(await getAccountFreezeState(userId)).toMatchObject({ frozen: false, scope: null });

    await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'test hold',
      placedByUserId: adminId,
    });
    expect(await getAccountFreezeState(userId)).toMatchObject({
      frozen: true,
      scope: 'debits_only',
    });
  });

  it('FAILS CLOSED: a missing user row and a throwing executor both resolve to frozen(full)', async () => {
    // Missing user row.
    const missing = await getAccountFreezeState('00000000-0000-0000-0000-000000000000');
    expect(missing).toMatchObject({ frozen: true, scope: 'full' });

    // DB read error (executor whose .select throws) → fail closed.
    const throwing = {
      select() {
        throw new Error('simulated mirror read failure');
      },
    } as unknown as typeof db;
    const errored = await getAccountFreezeState('any', throwing);
    expect(errored).toMatchObject({ frozen: true, scope: 'full' });
  });

  it('strict-AML: BOTH scopes block money OUT AND money IN (earned payouts)', async () => {
    const debitsUser = await seedUser();
    const fullUser = await seedUser();
    const adminId = await seedUser();
    await accountFreezeService.placeHold({
      userId: debitsUser,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'test hold',
      placedByUserId: adminId,
    });
    await accountFreezeService.placeHold({
      userId: fullUser,
      scope: 'full',
      reasonCode: 'sanctions_screening',
      reason: 'test full hold',
      placedByUserId: adminId,
    });

    // debits_only: money OUT blocked AND earned payout (money IN) paused
    // (strict-AML: a flagged account receives nothing until cleared).
    expect(await isFrozenForIntent(debitsUser, 'user_spend')).toBe(true);
    expect(await isFrozenForIntent(debitsUser, 'user_withdrawal')).toBe(true);
    expect(await isFrozenForIntent(debitsUser, 'system_payout')).toBe(true);

    // full: everything blocked too.
    expect(await isFrozenForIntent(fullUser, 'user_spend')).toBe(true);
    expect(await isFrozenForIntent(fullUser, 'system_payout')).toBe(true);

    // assertAccountNotFrozen mirrors it — a debits_only hold now also
    // refuses a system_payout (strict-AML).
    await expect(assertAccountNotFrozen(debitsUser, 'user_spend')).rejects.toBeInstanceOf(
      AccountFrozenError,
    );
    await expect(assertAccountNotFrozen(debitsUser, 'system_payout')).rejects.toBeInstanceOf(
      AccountFrozenError,
    );
    await expect(assertAccountNotFrozen(fullUser, 'system_payout')).rejects.toBeInstanceOf(
      AccountFrozenError,
    );
  });

  it('guardAccountNotFrozen (the HTTP entry-gate helper) returns 403 for a blocked intent, null otherwise', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    const captured: Array<{ status: number; code: string }> = [];
    const fakeCtx = {
      json(body: { code: string }, status: number) {
        captured.push({ status, code: body.code });
        return { status } as unknown as Response;
      },
    } as unknown as Parameters<typeof guardAccountNotFrozen>[0];

    // Not frozen → null (proceed).
    expect(await guardAccountNotFrozen(fakeCtx, userId, 'user_spend')).toBeNull();

    await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'test hold',
      placedByUserId: adminId,
    });
    // debits_only: spend blocked (403), AND payout blocked (403) under
    // strict-AML — both intents refused.
    expect(await guardAccountNotFrozen(fakeCtx, userId, 'user_spend')).not.toBeNull();
    expect(await guardAccountNotFrozen(fakeCtx, userId, 'system_payout')).not.toBeNull();
    expect(captured.at(-1)).toEqual({ status: 403, code: 'ACCOUNT_FROZEN' });
  });
});

describeIf('NS-08 enforcement #5 — insertCreditOrderTxn (authoritative in-txn)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedBalance(userId: string, balanceMinor: bigint): Promise<void> {
    await seedUserCreditsWithBackingLedger(db, { userId, currency: 'USD', balanceMinor });
  }
  async function orderCount(userId: string): Promise<number> {
    return (await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, userId)))
      .length;
  }
  async function spendCount(userId: string): Promise<number> {
    return (
      await db
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.type, 'spend')))
    ).length;
  }
  async function usdBalance(userId: string): Promise<bigint | null> {
    const rows = await db
      .select({ balanceMinor: userCredits.balanceMinor })
      .from(userCredits)
      .where(and(eq(userCredits.userId, userId), eq(userCredits.currency, 'USD')));
    return rows[0]?.balanceMinor ?? null;
  }

  it('FROZEN (debits_only): the credit-order spend throws AccountFrozenError and rolls back — no order, no debit', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    await seedBalance(userId, 10_000n);
    await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'freeze before spend',
      placedByUserId: adminId,
    });

    await expect(
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
    ).rejects.toBeInstanceOf(AccountFrozenError);

    // Whole txn rolled back — un-debited, no order, no spend row.
    expect(await orderCount(userId)).toBe(0);
    expect(await spendCount(userId)).toBe(0);
    expect(await usdBalance(userId)).toBe(10_000n);
  });

  it('UNFROZEN: the same credit-order spend commits (order paid + one spend + balance debited)', async () => {
    const userId = await seedUser();
    await seedBalance(userId, 10_000n);

    const order = await insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n }));
    expect(order.state).toBe('paid');
    expect(await orderCount(userId)).toBe(1);
    expect(await spendCount(userId)).toBe(1);
    expect(await usdBalance(userId)).toBe(5_000n);
  });

  it('UNFROZEN after release: a frozen-then-released account can spend again', async () => {
    const userId = await seedUser();
    const adminId = await seedUser();
    await seedBalance(userId, 10_000n);
    const hold = await accountFreezeService.placeHold({
      userId,
      scope: 'debits_only',
      reasonCode: 'suspected_fraud',
      reason: 'temp',
      placedByUserId: adminId,
    });
    await expect(
      insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n })),
    ).rejects.toBeInstanceOf(AccountFrozenError);

    await accountFreezeService.releaseHold({
      holdId: hold.id,
      releaseReason: 'cleared',
      releasedByUserId: adminId,
    });
    const order = await insertCreditOrderTxn(baseValues(userId, { chargeMinor: 5000n }));
    expect(order.state).toBe('paid');
    expect(await usdBalance(userId)).toBe(5_000n);
  });
});

describeIf(
  'NS-08 enforcement #9 — payout worker defers earned payouts to a frozen wallet (either scope)',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });
    beforeEach(async () => {
      await truncateAllTables();
    });

    const PAY_ARGS = {
      operatorSecret: 'STESTSECRET',
      operatorAccount: 'GTESTOPERATOR',
      horizonUrl: 'https://horizon-test.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      maxAttempts: 5,
    };

    // Seeds a PENDING outbound-payout row to the user's wallet. Uses
    // `emission` (money IN to the wallet — no order FK; ASH decision #2
    // lists cashback/interest/emission, all of which take the identical
    // `kind !== 'burn'` freeze-defer path in payOne). Backs it with a
    // matching mirror balance so the emission-conservation trigger passes.
    async function seedEarnedPayout(userId: string): Promise<string> {
      await seedUserCreditsWithBackingLedger(db, { userId, currency: 'USD', balanceMinor: 500n });
      const [row] = await db
        .insert(pendingPayouts)
        .values({
          userId,
          kind: 'emission',
          assetCode: 'USDLOOP',
          assetIssuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          toAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          amountStroops: 50_000_000n,
          memoText: `ns08-payout-${Date.now()}-${Math.random()}`,
          state: 'pending',
        })
        .returning({ id: pendingPayouts.id });
      if (row === undefined) throw new Error('seed payout returned no row');
      return row.id;
    }

    // Strict-AML: BOTH scopes defer an earned payout — a flagged account
    // receives nothing until cleared. Parametrised over both scopes.
    for (const scope of ['debits_only', 'full'] as const) {
      it(`${scope} hold: payOne DEFERS (retriedLater) — the row stays pending, attempts unchanged, nothing submitted`, async () => {
        const userId = await seedUser();
        const adminId = await seedUser();
        const payoutId = await seedEarnedPayout(userId);
        await accountFreezeService.placeHold({
          userId,
          scope,
          reasonCode: 'aml_review',
          reason: `AML hold (${scope})`,
          placedByUserId: adminId,
        });

        const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
        const outcome = await payOne(row!, PAY_ARGS);

        expect(outcome).toBe('retriedLater');
        const [after] = await db
          .select()
          .from(pendingPayouts)
          .where(eq(pendingPayouts.id, payoutId));
        expect(after!.state).toBe('pending'); // still pending — deferred, not paid
        expect(after!.attempts).toBe(0); // no submit attempt burned
        expect(after!.txHash).toBeNull();
      });
    }

    it('after release, the deferred payout is no longer frozen (re-drains on the next tick)', async () => {
      const userId = await seedUser();
      const adminId = await seedUser();
      const payoutId = await seedEarnedPayout(userId);
      const hold = await accountFreezeService.placeHold({
        userId,
        scope: 'debits_only',
        reasonCode: 'suspected_fraud',
        reason: 'temp hold',
        placedByUserId: adminId,
      });
      // While held, the earned payout defers.
      const [held] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
      expect(await payOne(held!, PAY_ARGS)).toBe('retriedLater');

      // Release → the payout intent is no longer frozen, so the next tick
      // would submit normally (asserted at the gate predicate to avoid a
      // live Horizon submit).
      await accountFreezeService.releaseHold({
        holdId: hold.id,
        releaseReason: 'cleared',
        releasedByUserId: adminId,
      });
      expect(await isFrozenForIntent(userId, 'system_payout')).toBe(false);
    });
  },
);
