/**
 * Admin write-surface integration tests (ADR 017).
 *
 * The three ADR-017 admin writes — credit-adjustment, refund, and
 * withdrawal — share the idempotency-guarded ladder
 * (`withIdempotencyGuard` → handler-supplied write → snapshot persist
 * → audit fanout). Each handler has unit-test coverage of the
 * function-call shape, but the cross-cutting invariants only show up
 * under real postgres:
 *
 *   - The advisory-lock serialization in `pg_advisory_xact_lock`
 *     (A2-2001 — concurrent calls with the same idempotency key
 *     must serialise, not both pass the lookup).
 *   - The partial unique indexes on
 *     `(type, reference_type, reference_id)` that catch duplicate
 *     refund + withdrawal writes against the same order/payout id
 *     (`REFUND_ALREADY_ISSUED`, `WITHDRAWAL_ALREADY_ISSUED`).
 *   - The `credit_transactions_amount_sign` CHECK constraint that
 *     pins cashback/refund > 0 and spend/withdrawal/adjustment-debit < 0.
 *   - The atomic two-row write inside `applyAdminWithdrawal`
 *     (`credit_transactions` debit + `pending_payouts` queue) — both
 *     land or neither does.
 *
 * Walks each happy path + the duplicate-rejection path through the
 * real ledger. Mirrors the flywheel.test.ts harness — same
 * `LOOP_E2E_DB=1` gate, same fork pool, same per-test truncate.
 *
 * What’s mocked: discord notifiers (fire-and-forget after commit).
 * What’s REAL: every postgres CHECK + every partial unique index +
 * the advisory-lock txn semantics + Hono routing + the Loop-signed
 * admin auth path (`requireAuth` + `requireAdmin`).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Discord notifiers fire-and-forget; mocking keeps test logs quiet.
// `notifyAdminBulkRead` is a vi.fn() (not a noop) so the dedicated
// admin-read audit middleware test block at the bottom of this file
// can assert on its call shape without re-mocking.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyAdminAudit: noop,
    notifyCashbackConfigChanged: noop,
    notifyAdminBulkRead: vi.fn(),
  };
});

import { db } from '../../db/client.js';
import { users, orders, creditTransactions, userCredits, pendingPayouts } from '../../db/schema.js';
import { findOrCreateUserByEmail, upsertUserFromCtx } from '../../db/users.js';
import { app, __resetRateLimitsForTests } from '../../app.js';
import { notifyAdminBulkRead } from '../../discord.js';
import { signLoopToken } from '../../auth/tokens.js';
import { signAdminStepUpToken } from '../../auth/admin-step-up.js';
import { env } from '../../env.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Random idempotency key (28 base64url chars — well above the 16 floor). */
function idemKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('base64url');
}

interface SeededState {
  adminUserId: string;
  targetUser: { id: string; email: string };
  bearer: string;
  /**
   * ADR-028 / A4-063: step-up token for the seeded admin. Sent as
   * `X-Admin-Step-Up` on the gated destructive endpoints
   * (credit-adjust / withdrawal / payout-retry). Minted at seed time
   * so the per-test setup doesn't have to round-trip through the
   * `POST /api/admin/step-up` handler — the integration value here is
   * proving the gated handler accepts a valid token, not the
   * step-up minting flow itself (covered by unit tests).
   */
  stepUp: string;
  orderId: string;
}

async function seedCashbackBalance(args: {
  userId: string;
  currency?: 'USD' | 'GBP' | 'EUR';
  amountMinor: bigint;
}): Promise<void> {
  const currency = args.currency ?? 'USD';
  await db.insert(creditTransactions).values({
    userId: args.userId,
    type: 'cashback',
    amountMinor: args.amountMinor,
    currency,
    referenceType: 'order',
    referenceId: crypto.randomUUID(),
  });
  await db.insert(userCredits).values({
    userId: args.userId,
    currency,
    balanceMinor: args.amountMinor,
  });
}

async function seedFailedWithdrawalPayout(args: {
  userId: string;
  assetCode?: string;
  assetIssuer?: string;
  toAddress?: string;
  amountStroops: bigint;
}): Promise<string> {
  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: args.userId,
      kind: 'withdrawal',
      assetCode: args.assetCode ?? 'USDLOOP',
      assetIssuer: args.assetIssuer ?? 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: args.toAddress ?? 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: args.amountStroops,
      memoText: 'withdrawal-test',
      state: 'failed',
      lastError: 'seeded failed payout',
      failedAt: new Date(),
      attempts: 1,
    })
    .returning({ id: pendingPayouts.id });
  if (row === undefined) throw new Error('seedFailedWithdrawalPayout: insert returned no row');
  return row.id;
}

/**
 * Inserts an admin user, a target user, and a fulfilled order so
 * refund tests have something to bind to. Returns the IDs the tests
 * need.
 */
async function seed(): Promise<SeededState> {
  // Admin: seed through the CTX allowlist so the stored user row has
  // `isAdmin=true`, then mint a Loop-signed access token for the
  // actual request path under test.
  const admin = await upsertUserFromCtx({
    ctxUserId: 'test-admin-id',
    email: 'admin@test.local',
  });
  const { token } = signLoopToken({
    sub: admin.id,
    email: admin.email,
    typ: 'access',
    ttlSeconds: 300,
  });
  const { token: stepUp } = signAdminStepUpToken({
    sub: admin.id,
    email: admin.email,
  });
  const target = await findOrCreateUserByEmail('target@test.local');
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, target.id));

  // Insert a fulfilled order so refund has a `referenceId` to bind.
  const [orderRow] = await db
    .insert(orders)
    .values({
      userId: target.id,
      merchantId: 'amazon',
      faceValueMinor: 5000n,
      currency: 'USD',
      chargeMinor: 5000n,
      chargeCurrency: 'USD',
      // `credit` payment method skips the memo coherence CHECK
      // (orders_payment_memo_coherence — non-credit methods require a
      // payment_memo for the watcher to match deposits). Refund tests
      // bind to the order's id, not its payment method.
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 3500n,
      userCashbackMinor: 250n,
      loopMarginMinor: 1250n,
      state: 'fulfilled',
    })
    .returning();
  if (orderRow === undefined) throw new Error('seed: order insert returned no row');

  return {
    adminUserId: admin.id,
    targetUser: { id: target.id, email: target.email },
    bearer: token,
    stepUp,
    orderId: orderRow.id,
  };
}

describeIf('admin credit-adjustment write — real postgres ladder', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('credit happy path: writes ledger row + bumps balance + returns envelope', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const key = idemKey();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': key,
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({
          amountMinor: '500',
          currency: 'USD',
          reason: 'integration test happy path',
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { amountMinor: string; newBalanceMinor: string };
      audit: { replayed: boolean; idempotencyKey: string };
    };
    expect(body.result.amountMinor).toBe('500');
    expect(body.result.newBalanceMinor).toBe('500');
    expect(body.audit.replayed).toBe(false);
    expect(body.audit.idempotencyKey).toBe(key);

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(500n);

    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.type).toBe('adjustment');
    expect(txRows[0]!.amountMinor).toBe(500n);
  });

  it('replays the stored snapshot when the same idempotency key arrives again', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const key = idemKey();
    const body = JSON.stringify({
      amountMinor: '300',
      currency: 'USD',
      reason: 'replay test',
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      'X-Admin-Step-Up': stepUp,
    };
    const url = `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`;
    const first = await app.request(url, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { audit: { replayed: boolean }; result: unknown };
    expect(firstBody.audit.replayed).toBe(false);

    const second = await app.request(url, { method: 'POST', headers, body });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      audit: { replayed: boolean };
      result: unknown;
    };
    expect(secondBody.audit.replayed).toBe(true);
    expect(secondBody.result).toEqual(firstBody.result);

    // Critical assertion: the replay path didn't double-write. One
    // ledger row, one balance bump.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(300n);
  });

  it('rejects a debit that would drive the balance negative with 409 INSUFFICIENT_BALANCE', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // Target user has a $0 balance. Try to debit $5.
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({
          amountMinor: '-500',
          currency: 'USD',
          reason: 'debit test',
        }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    // No ledger row should have landed on the rejected attempt.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(0);
  });

  it('serialises the daily adjustment cap across concurrent writes to different users', async () => {
    const previousCap = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 500n;
    try {
      const { bearer, targetUser, stepUp } = await seed();
      const secondTarget = await findOrCreateUserByEmail('target-2@test.local');
      await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, secondTarget.id));

      const makeRequest = (
        userId: string,
        amountMinor: string,
        reason: string,
        key: string,
      ): Promise<Response> =>
        Promise.resolve(
          app.request(`http://localhost/api/admin/users/${userId}/credit-adjustments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bearer}`,
              'idempotency-key': key,
              'X-Admin-Step-Up': stepUp,
            },
            body: JSON.stringify({
              amountMinor,
              currency: 'USD',
              reason,
            }),
          }),
        );

      const [first, second] = await Promise.all([
        makeRequest(targetUser.id, '400', 'concurrent cap test first', `${idemKey()}-a`),
        makeRequest(secondTarget.id, '400', 'concurrent cap test second', `${idemKey()}-b`),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 429]);

      const txRows = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.referenceType, 'admin_adjustment'));
      expect(txRows).toHaveLength(1);
      expect(txRows[0]!.amountMinor).toBe(400n);
    } finally {
      env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = previousCap;
    }
  });
});

describeIf('admin refund write — real postgres ladder + duplicate guard', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('refund happy path: order-bound credit-tx + balance bumped', async () => {
    const { targetUser, bearer, orderId } = await seed();
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
      },
      body: JSON.stringify({
        amountMinor: '1000',
        currency: 'USD',
        orderId,
        reason: 'integration test refund',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { amountMinor: string; orderId: string; newBalanceMinor: string };
      audit: { replayed: boolean };
    };
    expect(body.result.amountMinor).toBe('1000');
    expect(body.result.orderId).toBe(orderId);
    expect(body.result.newBalanceMinor).toBe('1000');
    expect(body.audit.replayed).toBe(false);

    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.type).toBe('refund');
    expect(txRows[0]!.referenceType).toBe('order');
    expect(txRows[0]!.referenceId).toBe(orderId);
    expect(txRows[0]!.amountMinor).toBe(1000n);
  });

  it('rejects a second refund for the same orderId with 409 REFUND_ALREADY_ISSUED', async () => {
    const { targetUser, bearer, orderId } = await seed();
    const url = `http://localhost/api/admin/users/${targetUser.id}/refunds`;
    const headers = (key: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
    });
    const body = JSON.stringify({
      amountMinor: '500',
      currency: 'USD',
      orderId,
      reason: 'first refund',
    });

    // First refund — happy path.
    const first = await app.request(url, { method: 'POST', headers: headers(idemKey()), body });
    expect(first.status).toBe(200);

    // Second refund for the SAME orderId via a DIFFERENT idempotency
    // key (so the snapshot replay can't hide the duplicate). This is
    // the partial unique index path:
    //   credit_transactions_refund_unique
    //   on (type, reference_type, reference_id)
    //   where type = 'refund'
    // Inserting a second row trips the unique violation; the handler
    // catches and surfaces 409 REFUND_ALREADY_ISSUED.
    const second = await app.request(url, {
      method: 'POST',
      headers: headers(idemKey()),
      body: JSON.stringify({
        amountMinor: '300',
        currency: 'USD',
        orderId,
        reason: 'second refund attempt',
      }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { code: string };
    expect(secondBody.code).toBe('REFUND_ALREADY_ISSUED');

    // Ledger has exactly the first refund — second never landed.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.amountMinor).toBe(500n);
  });
});

describeIf('admin withdrawal write — real postgres ladder + atomic two-row txn', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('withdrawal happy path: debits balance + queues pending_payouts row in one txn', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // Withdrawal needs an existing balance to debit. Pre-seed a
    // credit_transactions row + user_credits balance directly so we
    // don't reach for a separate flow.
    await db.insert(creditTransactions).values({
      userId: targetUser.id,
      type: 'cashback',
      amountMinor: 2000n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: '00000000-0000-0000-0000-000000000001',
    });
    await db.insert(userCredits).values({
      userId: targetUser.id,
      currency: 'USD',
      balanceMinor: 2000n,
    });

    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/withdrawals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress,
        reason: 'integration test withdrawal',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { amountMinor: string; payoutId: string; newBalanceMinor: string };
    };
    expect(body.result.amountMinor).toBe('500');
    expect(body.result.newBalanceMinor).toBe('1500'); // 2000 - 500
    expect(body.result.payoutId).toBeTruthy();

    // Both rows landed atomically: the negative ledger row
    // (CHECK passes because withdrawal < 0) AND the pending_payouts
    // queue row.
    const withdrawalTx = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, body.result.payoutId));
    expect(withdrawalTx).toHaveLength(1);
    expect(withdrawalTx[0]!.type).toBe('withdrawal');
    expect(withdrawalTx[0]!.amountMinor).toBe(-500n);

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, body.result.payoutId));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.userId).toBe(targetUser.id);
    expect(payouts[0]!.toAddress).toBe(destinationAddress);
    expect(payouts[0]!.amountStroops).toBe(500n * 100_000n);
    expect(payouts[0]!.state).toBe('pending');

    // Balance debited end-to-end.
    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(1500n);
  });

  it('rejects a second semantic duplicate withdrawal with a fresh idempotency key', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `http://localhost/api/admin/users/${targetUser.id}/withdrawals`;
    const body = JSON.stringify({
      amountMinor: '500',
      currency: 'USD',
      destinationAddress,
      reason: 'integration duplicate withdrawal',
    });

    const first = await app.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body,
    });
    expect(first.status).toBe(200);

    const second = await app.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body,
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { code: string };
    expect(secondBody.code).toBe('WITHDRAWAL_ALREADY_ISSUED');

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(1);

    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(2);
    expect(txRows.filter((row) => row.type === 'withdrawal')).toHaveLength(1);

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(1500n);
  });

  it('serialises concurrent same-key withdrawal requests into one write plus one replay', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const idempotencyKey = idemKey();
    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `http://localhost/api/admin/users/${targetUser.id}/withdrawals`;
    const body = JSON.stringify({
      amountMinor: '500',
      currency: 'USD',
      destinationAddress,
      reason: 'same-key contention test',
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': idempotencyKey,
      'X-Admin-Step-Up': stepUp,
    };

    const [first, second] = await Promise.all([
      Promise.resolve(app.request(url, { method: 'POST', headers, body })),
      Promise.resolve(app.request(url, { method: 'POST', headers, body })),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as {
      audit: { replayed: boolean };
      result: { payoutId: string };
    };
    const secondBody = (await second.json()) as {
      audit: { replayed: boolean };
      result: { payoutId: string };
    };
    expect([firstBody.audit.replayed, secondBody.audit.replayed].sort()).toEqual([false, true]);
    expect(firstBody.result.payoutId).toBe(secondBody.result.payoutId);

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(1);

    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows.filter((row) => row.type === 'withdrawal')).toHaveLength(1);

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(1500n);
  });

  it('rejects a withdrawal exceeding the balance with 400 INSUFFICIENT_BALANCE', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // No prior balance. Try to withdraw $5.
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/withdrawals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        reason: 'overdraft attempt',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');

    // Neither side of the two-row txn landed.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(0);
    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(0);
  });

  it('keeps retry and compensation at-most-once when both hit the same failed payout', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 1500n });
    const payoutId = await seedFailedWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 500n * 100_000n,
    });
    await db.insert(creditTransactions).values({
      userId: targetUser.id,
      type: 'withdrawal',
      amountMinor: -500n,
      currency: 'USD',
      referenceType: 'payout',
      referenceId: payoutId,
      reason: 'seeded withdrawal backing failed payout',
    });

    const [retryRes, compensateRes] = await Promise.all([
      Promise.resolve(
        app.request(`http://localhost/api/admin/payouts/${payoutId}/retry`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'idempotency-key': idemKey(),
            'X-Admin-Step-Up': stepUp,
          },
          body: JSON.stringify({ reason: 'race retry' }),
        }),
      ),
      Promise.resolve(
        app.request(`http://localhost/api/admin/payouts/${payoutId}/compensate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'idempotency-key': idemKey(),
          },
          body: JSON.stringify({ reason: 'race compensate' }),
        }),
      ),
    ]);

    const [payout] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(payout).toBeDefined();

    const adjustmentRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, payoutId));
    const compensationRows = adjustmentRows.filter((row) => row.type === 'adjustment');

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));

    const retryBody = (await retryRes.json()) as { code?: string };
    const compensateBody = (await compensateRes.json()) as { code?: string };

    if (retryRes.status === 200) {
      expect(compensateRes.status).toBe(409);
      expect(compensateBody.code).toBe('PAYOUT_NOT_COMPENSABLE');
      expect(payout?.state).toBe('pending');
      expect(payout?.compensatedAt).toBeNull();
      expect(compensationRows).toHaveLength(0);
      expect(credit?.balanceMinor).toBe(1500n);
    } else {
      expect(retryRes.status).toBe(404);
      expect(retryBody.code).toBe('NOT_FOUND');
      expect(compensateRes.status).toBe(200);
      expect(payout?.state).toBe('failed');
      expect(payout?.compensatedAt).not.toBeNull();
      expect(compensationRows).toHaveLength(1);
      expect(credit?.balanceMinor).toBe(2000n);
    }
  });
});

describeIf('routes/admin.ts — admin-read audit middleware (A2-2008)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
    vi.mocked(notifyAdminBulkRead).mockReset();
  });

  it('fires notifyAdminBulkRead on a 200 GET to a .csv endpoint', async () => {
    const { bearer } = await seed();
    // /api/admin/audit-tail.csv handles empty data gracefully (it's
    // the admin-write audit log; a fresh DB has none). Any 200 GET
    // ending in .csv triggers the middleware path we want to assert
    // on; the middleware skips non-200 / non-GET / non-CSV paths.
    const res = await app.request('http://localhost/api/admin/audit-tail.csv', {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
    expect(notifyAdminBulkRead).toHaveBeenCalledTimes(1);
    const call = vi.mocked(notifyAdminBulkRead).mock.calls[0]?.[0];
    expect(call?.endpoint).toBe('GET /api/admin/audit-tail.csv');
  });

  it('does NOT fire notifyAdminBulkRead on a non-CSV admin GET', async () => {
    const { bearer } = await seed();
    const res = await app.request('http://localhost/api/admin/treasury', {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
    expect(notifyAdminBulkRead).not.toHaveBeenCalled();
  });

  it('does NOT fire notifyAdminBulkRead on an unauth GET (401 short-circuits)', async () => {
    const res = await app.request('http://localhost/api/admin/audit-tail.csv', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
    expect(notifyAdminBulkRead).not.toHaveBeenCalled();
  });

  // Smoke coverage for admin GET endpoints — each is hit on an empty
  // DB (the per-test truncate) with default query params. Catches:
  //
  //   - The Date-binding bug class (PR #1304 / #1306 / #1307) where
  //     `${since}` against postgres-js throws at bind time.
  //   - SQL drift bugs where a column rename / migration mismatch
  //     means the handler can't even parse against current schema.
  //   - NPE-on-empty-data bugs where a handler maps over an array
  //     without null-checking.
  //
  // A 200 here doesn't prove the handler is correct against real
  // data — the body might be wrong — but it does prove the SQL
  // parses + binds + the response builder runs end-to-end. That's
  // a high-value smoke gate because the failure mode for the
  // surfaced bugs is "every call 500s in production".
  it.each([
    ['/api/admin/supplier-spend'],
    ['/api/admin/operator-stats'],
    ['/api/admin/top-users'],
    ['/api/admin/operators/latency'],
    ['/api/admin/treasury'],
    ['/api/admin/payouts'],
    ['/api/admin/stuck-orders'],
    ['/api/admin/stuck-payouts'],
    ['/api/admin/cashback-activity'],
    ['/api/admin/cashback-monthly'],
    ['/api/admin/cashback-realization'],
    ['/api/admin/merchant-cashback-configs'],
    ['/api/admin/merchant-flows'],
    ['/api/admin/merchant-stats'],
    ['/api/admin/payouts-monthly'],
    ['/api/admin/payouts-activity'],
    ['/api/admin/payouts-by-asset'],
    ['/api/admin/audit-tail'],
    ['/api/admin/users'],
    ['/api/admin/orders'],
  ])('GET %s on empty DB returns 200', async (path) => {
    const { bearer } = await seed();
    const res = await app.request(`http://localhost${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
  });
});

describeIf('admin home-currency write — real postgres ladder + safety preflight', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('happy path: flips home_currency, returns envelope, persists updated_at', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const before = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(before[0]?.homeCurrency).toBe('USD');

    const key = idemKey();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': key,
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'support ticket #42' }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { priorHomeCurrency: string; newHomeCurrency: string; updatedAt: string };
      audit: { replayed: boolean; idempotencyKey: string };
    };
    expect(body.result.priorHomeCurrency).toBe('USD');
    expect(body.result.newHomeCurrency).toBe('GBP');
    expect(body.audit.replayed).toBe(false);
    expect(body.audit.idempotencyKey).toBe(key);

    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('GBP');
  });

  it('replays the stored snapshot on idempotency-key reuse without re-running the preflight', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const key = idemKey();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      'X-Admin-Step-Up': stepUp,
    };
    const url = `http://localhost/api/admin/users/${targetUser.id}/home-currency`;
    const body = JSON.stringify({ homeCurrency: 'GBP', reason: 'idempotent retry' });

    const first = await app.request(url, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { audit: { replayed: boolean }; result: unknown };
    expect(firstBody.audit.replayed).toBe(false);

    // Seed a balance in the now-old USD currency. A live preflight would
    // reject; the snapshot replay must NOT re-run the preflight.
    await seedCashbackBalance({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 250n,
    });

    const second = await app.request(url, { method: 'POST', headers, body });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      audit: { replayed: boolean };
      result: unknown;
    };
    expect(secondBody.audit.replayed).toBe(true);
    expect(secondBody.result).toEqual(firstBody.result);

    // Critical: only one transition; the user is still on GBP.
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('GBP');
  });

  it('409 HOME_CURRENCY_UNCHANGED when new currency equals current', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'USD', reason: 'no-op' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_UNCHANGED');
  });

  it('409 HOME_CURRENCY_HAS_LIVE_BALANCE when user has non-zero credits in old currency', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 1234n,
    });

    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'should fail' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('HOME_CURRENCY_HAS_LIVE_BALANCE');
    expect(body.message).toContain('1234');

    // No transition happened.
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('USD');
  });

  it('allows the change when user has a zero-balance row in the old currency', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // Insert a zero-balance row directly — `seedCashbackBalance` would
    // also write a credit_transactions row (which the schema CHECK
    // forbids at amount=0 for `cashback`). The row exists from a
    // prior settled cashback that was later debited to zero.
    await db.insert(userCredits).values({
      userId: targetUser.id,
      currency: 'USD',
      balanceMinor: 0n,
    });

    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'EUR', reason: 'zero-balance ok' }),
      },
    );
    expect(res.status).toBe(200);
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('EUR');
  });

  it('409 HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS when user has a pending payout', async () => {
    const { targetUser, bearer, stepUp, orderId } = await seed();
    await db.insert(pendingPayouts).values({
      userId: targetUser.id,
      kind: 'order_cashback',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: 10_000_000n,
      memoText: 'inflight-test',
      orderId,
      state: 'pending',
    });

    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'should fail' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS');
  });

  it('allows the change when user has only failed payouts (already off the worker hot path)', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedFailedWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 5_000_000n,
    });
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'EUR', reason: 'failed payouts ok' }),
      },
    );
    expect(res.status).toBe(200);
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('EUR');
  });

  it('404 USER_NOT_FOUND when target user does not exist', async () => {
    const { bearer, stepUp } = await seed();
    const res = await app.request(
      `http://localhost/api/admin/users/aaaaaaaa-bbbb-cccc-dddd-000000000000/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': stepUp,
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'no such user' }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('401 STEP_UP_REQUIRED without an X-Admin-Step-Up header', async () => {
    const { targetUser, bearer } = await seed();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'no step-up' }),
      },
    );
    expect(res.status).toBe(401);
  });
});
