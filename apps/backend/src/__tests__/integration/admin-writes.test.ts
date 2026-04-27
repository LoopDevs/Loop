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
 * What's mocked: discord notifiers (fire-and-forget after commit).
 * What's REAL: every postgres CHECK + every partial unique index +
 * the advisory-lock txn semantics + Hono routing + the legacy
 * CTX-anchored admin auth path (`requireAuth` + `requireAdmin`).
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
import { app } from '../../app.js';
import { notifyAdminBulkRead } from '../../discord.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/**
 * Mints a CTX-style bearer (legacy `decodeJwtPayload` path —
 * unverified base64url JSON payload). The admin middleware uses
 * `decodeJwtPayload(bearer).sub` to look up the user; setting `sub`
 * to the admin's `ctx_user_id` is enough to land on the admin row
 * via `upsertUserFromCtx`. Signature segment is junk (`x`) — the
 * decode path doesn't verify.
 */
function mintCtxBearer(sub: string, email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, email })).toString('base64url');
  return `${header}.${payload}.x`;
}

/** Random idempotency key (28 base64url chars — well above the 16 floor). */
function idemKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('base64url');
}

interface SeededState {
  adminUserId: string;
  targetUser: { id: string; email: string };
  bearer: string;
  orderId: string;
}

/**
 * Inserts an admin user, a target user, and a fulfilled order so
 * refund tests have something to bind to. Returns the IDs the tests
 * need.
 */
async function seed(): Promise<SeededState> {
  // Admin: ctx_user_id matches `ADMIN_CTX_USER_IDS` env (test-admin-id
  // pinned in vitest-integration-setup.ts) so isAdmin=true.
  const admin = await upsertUserFromCtx({
    ctxUserId: 'test-admin-id',
    email: 'admin@test.local',
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
    bearer: mintCtxBearer('test-admin-id', 'admin@test.local'),
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
    const { targetUser, bearer } = await seed();
    const key = idemKey();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': key,
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
    const { targetUser, bearer } = await seed();
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
    const { targetUser, bearer } = await seed();
    // Target user has a $0 balance. Try to debit $5.
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
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
    const { targetUser, bearer } = await seed();
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

  it('rejects a withdrawal exceeding the balance with 400 INSUFFICIENT_BALANCE', async () => {
    const { targetUser, bearer } = await seed();
    // No prior balance. Try to withdraw $5.
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/withdrawals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
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
});

describeIf('routes/admin.ts — admin-read audit middleware (A2-2008)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
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
});
