/**
 * Admin write-surface integration tests (ADR 017).
 *
 * The three ADR-017 admin writes — credit-adjustment, refund, and
 * emission (ex-withdrawal, re-scoped by ADR 036) — share the
 * idempotency-guarded ladder
 * (`withIdempotencyGuard` → handler-supplied write → snapshot persist
 * → audit fanout). Each handler has unit-test coverage of the
 * function-call shape, but the cross-cutting invariants only show up
 * under real postgres:
 *
 *   - The advisory-lock serialization in `pg_advisory_xact_lock`
 *     (A2-2001 — concurrent calls with the same idempotency key
 *     must serialise, not both pass the lookup).
 *   - The partial unique indexes that catch duplicate refund writes
 *     against the same order id (`REFUND_ALREADY_ISSUED`) and
 *     duplicate active emission intents
 *     (`EMISSION_ALREADY_ISSUED`, ADR 036).
 *   - The `credit_transactions_amount_sign` CHECK constraint that
 *     pins cashback/refund > 0 and spend/withdrawal/adjustment-debit < 0.
 *   - ADR 036: the emission write queues ONLY a `pending_payouts`
 *     row — no ledger row, no balance change. Assertions pin the
 *     mirror staying untouched end-to-end.
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
import { eq, sql } from 'drizzle-orm';

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
import {
  users,
  orders,
  creditTransactions,
  userCredits,
  pendingPayouts,
  adminIdempotencyKeys,
} from '../../db/schema.js';
import { findOrCreateUserByEmail, upsertUserFromCtx } from '../../db/users.js';
import { app, __resetRateLimitsForTests } from '../../app.js';
import { notifyAdminBulkRead } from '../../discord.js';
import { signLoopToken } from '../../auth/tokens.js';
import { signAdminStepUpToken } from '../../auth/admin-step-up.js';
import { adjustmentCapLockKey, DailyAdjustmentLimitError } from '../../credits/adjustments.js';
import { applyAdminEmission } from '../../credits/emissions.js';
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
   * step-up minting flow itself. That flow (OTP lookup/attempts/
   * consume + token mint, at the HTTP-handler layer) is covered by
   * `admin/__tests__/step-up-handler.test.ts`; the crypto-level mint/
   * verify primitives are covered separately by
   * `auth/__tests__/admin-step-up.test.ts`. CF-11 (06-15 audit) found
   * this comment previously claimed handler-level coverage that did
   * not actually exist — `step-up-handler.test.ts` closes that gap.
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

/**
 * Seeds a failed LEGACY withdrawal-era payout (pre-ADR-036): the
 * `kind='emission'` row PLUS the at-send `type='withdrawal'` debit
 * ledger row that marks it as legacy/compensable. Post-ADR-036
 * emissions carry no debit row — seed those inline where a test
 * needs one.
 */
async function seedFailedLegacyWithdrawalPayout(args: {
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
      kind: 'emission',
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
  if (row === undefined) {
    throw new Error('seedFailedLegacyWithdrawalPayout: insert returned no row');
  }
  // The legacy at-send debit — pre-ADR-036 withdrawals debited the
  // mirror when queueing. This row is the compensability marker.
  await db.insert(creditTransactions).values({
    userId: args.userId,
    type: 'withdrawal',
    amountMinor: -(args.amountStroops / 100_000n),
    currency: 'USD',
    referenceType: 'payout',
    referenceId: row.id,
    reason: 'seeded legacy at-send debit (pre-ADR-036)',
  });
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
    const { targetUser, bearer, stepUp, orderId } = await seed();
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        // CF-06: refund is now step-up-gated like its sibling writers.
        'X-Admin-Step-Up': stepUp,
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
    const { targetUser, bearer, stepUp, orderId } = await seed();
    const url = `http://localhost/api/admin/users/${targetUser.id}/refunds`;
    const headers = (key: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      // CF-06: refund is now step-up-gated like its sibling writers.
      'X-Admin-Step-Up': stepUp,
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

describeIf('admin emission write — real postgres ladder, mirror untouched (ADR 036)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  it('emission happy path: queues pending_payouts row; balance unchanged + no ledger row', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // The unbacked-emission guard requires an existing mirror
    // balance >= the emitted amount. Pre-seed a credit_transactions
    // row + user_credits balance directly.
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
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
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
        reason: 'integration test emission',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { amountMinor: string; payoutId: string; balanceMinor: string };
    };
    expect(body.result.amountMinor).toBe('500');
    // ADR 036: the reported mirror balance is the UNCHANGED balance.
    expect(body.result.balanceMinor).toBe('2000');
    expect(body.result.payoutId).toBeTruthy();

    // ADR 036: NO ledger row references the payout — emission writes
    // the queue row only.
    const emissionTx = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceId, body.result.payoutId));
    expect(emissionTx).toHaveLength(0);

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, body.result.payoutId));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.userId).toBe(targetUser.id);
    expect(payouts[0]!.kind).toBe('emission');
    expect(payouts[0]!.orderId).toBeNull();
    expect(payouts[0]!.toAddress).toBe(destinationAddress);
    expect(payouts[0]!.amountStroops).toBe(500n * 100_000n);
    expect(payouts[0]!.state).toBe('pending');

    // Mirror balance untouched end-to-end.
    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);

    // The user's ledger still holds exactly the seeded cashback row.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.type).toBe('cashback');
  });

  it('rejects a second semantic duplicate emission with a fresh idempotency key', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `http://localhost/api/admin/users/${targetUser.id}/emissions`;
    const body = JSON.stringify({
      amountMinor: '500',
      currency: 'USD',
      destinationAddress,
      reason: 'integration duplicate emission',
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
    expect(secondBody.code).toBe('EMISSION_ALREADY_ISSUED');

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(1);

    // Ledger holds only the seeded cashback row — neither emission
    // attempt wrote anything (ADR 036).
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(1);
    expect(txRows.filter((row) => row.type === 'withdrawal')).toHaveLength(0);

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);
  });

  it('serialises concurrent same-key emission requests into one write plus one replay', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const idempotencyKey = idemKey();
    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `http://localhost/api/admin/users/${targetUser.id}/emissions`;
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

    // Fire both requests before awaiting either so they genuinely
    // contend on the idempotency-key row inside the writer's
    // transaction, rather than running back-to-back.
    const firstPromise = app.request(url, { method: 'POST', headers, body });
    const secondPromise = app.request(url, { method: 'POST', headers, body });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

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
    // Exactly one request performed the write; the other replayed it.
    const replays = [firstBody.audit.replayed, secondBody.audit.replayed];
    expect(replays.filter((r) => r === false)).toHaveLength(1);
    expect(replays.filter((r) => r === true)).toHaveLength(1);
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
    expect(txRows.filter((row) => row.type === 'withdrawal')).toHaveLength(0);

    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);
  });

  it('rejects an emission exceeding the mirror balance with 400 INSUFFICIENT_BALANCE', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // No prior balance. Try to emit $5 — would mint unbacked LOOP.
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
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
        reason: 'unbacked emission attempt',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');

    // Nothing landed.
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

  it('ADR 036: compensation refuses a debit-less post-ADR-036 emission with 409', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    // A failed emission WITHOUT the legacy at-send debit row — the
    // post-ADR-036 shape. Compensating it would mint unbacked mirror
    // balance, so the primitive must refuse.
    const [row] = await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        kind: 'emission',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amountStroops: 500n * 100_000n,
        memoText: 'post-adr036-emission',
        state: 'failed',
        lastError: 'seeded failed payout',
        failedAt: new Date(),
        attempts: 1,
      })
      .returning({ id: pendingPayouts.id });
    const payoutId = row!.id;

    const res = await app.request(`http://localhost/api/admin/payouts/${payoutId}/compensate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        // CF-07: compensate is step-up-gated.
        'X-Admin-Step-Up': stepUp,
      },
      body: JSON.stringify({ reason: 'should be refused — no legacy debit' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAYOUT_NOT_COMPENSABLE');

    // No compensation row, no compensated marker, no balance change.
    const adjustments = (
      await db.select().from(creditTransactions).where(eq(creditTransactions.referenceId, payoutId))
    ).filter((r) => r.type === 'adjustment');
    expect(adjustments).toHaveLength(0);
    const [payout] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(payout?.compensatedAt).toBeNull();
    const credits = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credits).toHaveLength(0);
  });

  it('keeps retry and compensation at-most-once when both hit the same failed payout', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 1500n });
    const payoutId = await seedFailedLegacyWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 500n * 100_000n,
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
            // CF-07: compensate is now step-up-gated like its sibling /retry.
            'X-Admin-Step-Up': stepUp,
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

describeIf('hardening A1 — emission conservation (cumulative, cross-writer, DB fence)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  const DEST = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  async function emit(args: {
    userId: string;
    bearer: string;
    stepUp: string;
    amountMinor: string;
  }): Promise<Response> {
    return app.request(`http://localhost/api/admin/users/${args.userId}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': args.stepUp,
      },
      body: JSON.stringify({
        amountMinor: args.amountMinor,
        currency: 'USD',
        destinationAddress: DEST,
        reason: 'conservation integration test',
      }),
    });
  }

  it('rejects cumulative emissions past the liability — the audited unbacked-mint hole', async () => {
    // THE finding: each call passes `balance >= amount` because
    // emission never debits, so before A1 an admin could emit 1500,
    // then 800, then 800… against a 2000 balance forever.
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const first = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '1500' });
    expect(first.status).toBe(200);

    const second = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '800' });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; message: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');
    expect(body.message).toContain('500'); // remaining headroom named for the operator

    // Exactly the remaining headroom still emits fine.
    const third = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '500' });
    expect(third.status).toBe(200);
  });

  it('a CONFIRMED prior mint consumes headroom — its liability is already on-chain', async () => {
    // Seeded as a confirmed emission row: the conservation accounting
    // treats the three mint kinds (order_cashback / emission /
    // interest_mint) through one uniform IN-clause, and the kind-shape
    // CHECK requires order_cashback rows to carry a real order — the
    // state coverage (confirmed counts, failed doesn't) is what these
    // two tests pin.
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });
    await db.insert(pendingPayouts).values({
      userId: targetUser.id,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: DEST,
      amountStroops: 2000n * 100_000n,
      memoText: 'seeded confirmed prior emission',
      state: 'confirmed',
    });

    const res = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'EMISSION_EXCEEDS_UNEMITTED_BALANCE',
    );
  });

  it('a FAILED prior mint does NOT consume headroom — the backfill use case emission exists for', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });
    await db.insert(pendingPayouts).values({
      userId: targetUser.id,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: DEST,
      amountStroops: 2000n * 100_000n,
      memoText: 'seeded failed prior emission',
      state: 'failed',
      lastError: 'seeded terminal failure',
      attempts: 5,
    });

    const res = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '2000' });
    expect(res.status).toBe(200);
  });

  it('DB fence: a raw INSERT bypassing the app layer is rejected by the conservation trigger', async () => {
    // The GBPLOOP-mint lesson: app-layer allowlists get bypassed by
    // future writers. The trigger holds at the database boundary.
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 100n });

    let thrown: unknown = null;
    await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        kind: 'emission',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: 5000n * 100_000n, // 50× the liability
        memoText: 'rogue writer bypassing credits/emissions.ts',
      })
      .catch((err: unknown) => {
        thrown = err;
      });
    expect(thrown).not.toBeNull();
    const chain: string[] = [];
    let cursor: unknown = thrown;
    while (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(chain.join(' | ')).toMatch(/emission_conservation/);
  });

  it('retry-after-backfill double mint is rejected by the re-entry trigger (adversarial-review P0)', async () => {
    // The documented ops flow that would double-mint without the
    // UPDATE-side trigger: an emission fails terminally, ops re-emits
    // the backfill (legitimate — failed rows free headroom), and then
    // someone retries the ORIGINAL failed row from the payouts list.
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    // The original emission, terminally failed.
    const [failedRow] = await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        kind: 'emission',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: 2000n * 100_000n,
        memoText: 'original emission, terminally failed',
        state: 'failed',
        lastError: 'op_no_trust',
        attempts: 5,
      })
      .returning({ id: pendingPayouts.id });

    // The backfill emission — legitimate, consumes the full headroom.
    const backfill = await emit({ userId: targetUser.id, bearer, stepUp, amountMinor: '2000' });
    expect(backfill.status).toBe(200);

    // Retrying the original failed row would mint BOTH → 409.
    const retry = await app.request(`http://localhost/api/admin/payouts/${failedRow!.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body: JSON.stringify({ reason: 'attempting the double-mint retry' }),
    });
    expect(retry.status).toBe(409);
    const body = (await retry.json()) as { code: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');

    // The failed row stays failed — nothing re-entered the queue.
    const [row] = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, failedRow!.id));
    expect(row?.state).toBe('failed');
  });

  it('a legitimate retry (headroom intact) still passes the re-entry trigger', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });
    const [failedRow] = await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        kind: 'emission',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: 2000n * 100_000n,
        memoText: 'failed emission, headroom untouched',
        state: 'failed',
        lastError: 'transient_horizon exhausted',
        attempts: 5,
      })
      .returning({ id: pendingPayouts.id });

    const retry = await app.request(`http://localhost/api/admin/payouts/${failedRow!.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': stepUp,
      },
      body: JSON.stringify({ reason: 'legitimate retry, nothing re-materialised' }),
    });
    expect(retry.status).toBe(200);
    const [row] = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, failedRow!.id));
    expect(row?.state).toBe('pending');
  });

  it('fleet-wide daily emission cap: the primitive refuses past ADMIN_DAILY_WITHDRAWAL_CAP_MINOR', async () => {
    // Cap default is 100M minor. Drive the primitive directly (the
    // HTTP surface adds a 10M per-request cap that would need 10+
    // calls). Different amounts so the semantic-duplicate fence
    // doesn't fire first.
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 200_000_000n });

    const intent = (
      amountStroops: bigint,
    ): {
      assetCode: string;
      assetIssuer: string;
      toAddress: string;
      amountStroops: bigint;
      memoText: string;
    } => ({
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: DEST,
      amountStroops,
      memoText: `cap test ${amountStroops}`,
    });

    const first = await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 60_000_000n,
      intent: intent(60_000_000n * 100_000n),
    });
    expect(first.payoutId).toBeTruthy();

    let thrown: unknown = null;
    await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 50_000_000n,
      intent: intent(50_000_000n * 100_000n),
    }).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toBeInstanceOf(DailyAdjustmentLimitError);
  });
});

describeIf('admin payout-retry write — idempotency-guarded ladder', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
  });

  async function retryRequest(args: {
    payoutId: string;
    bearer: string;
    stepUp: string;
    key: string;
    reason: string;
  }): Promise<Response> {
    // async wrapper (not Promise.resolve) — `app.request` is invoked
    // synchronously at call time, so two calls assembled inside a
    // `Promise.all` are genuinely in flight together.
    return app.request(`http://localhost/api/admin/payouts/${args.payoutId}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.bearer}`,
        'idempotency-key': args.key,
        'X-Admin-Step-Up': args.stepUp,
      },
      body: JSON.stringify({ reason: args.reason }),
    });
  }

  it('replays the cached envelope on idempotency-key reuse — the reset runs exactly once', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const payoutId = await seedFailedLegacyWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 500n * 100_000n,
    });
    const key = idemKey();

    const first = await retryRequest({ payoutId, bearer, stepUp, key, reason: 'first click' });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      result: { id: string; state: string };
      audit: { replayed: boolean };
    };
    expect(firstBody.result.state).toBe('pending');
    expect(firstBody.audit.replayed).toBe(false);

    // Force the row back to `failed`. If the replay path re-ran the
    // reset, the state below would flip to `pending` again — the row
    // staying `failed` proves the write executed exactly once.
    await db
      .update(pendingPayouts)
      .set({ state: 'failed', failedAt: new Date(), lastError: 'failed again post-retry' })
      .where(eq(pendingPayouts.id, payoutId));

    const second = await retryRequest({ payoutId, bearer, stepUp, key, reason: 'second click' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      result: { id: string; state: string };
      audit: { replayed: boolean };
    };
    expect(secondBody.audit.replayed).toBe(true);
    expect(secondBody.result).toEqual(firstBody.result);

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row?.state).toBe('failed');
  });

  it('serialises truly-concurrent same-key retries into one reset plus one replay', async () => {
    const { targetUser, bearer, stepUp } = await seed();
    const payoutId = await seedFailedLegacyWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 500n * 100_000n,
    });
    const key = idemKey();

    // Both requests in flight at once — no Promise.resolve wrapper,
    // the two handler invocations genuinely race for the advisory
    // lock. Pre-guard both passed the unguarded lookup and both
    // reported a fresh (replayed: false) write.
    const [first, second] = await Promise.all([
      retryRequest({ payoutId, bearer, stepUp, key, reason: 'race click a' }),
      retryRequest({ payoutId, bearer, stepUp, key, reason: 'race click b' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { audit: { replayed: boolean } };
    const secondBody = (await second.json()) as { audit: { replayed: boolean } };
    expect([firstBody.audit.replayed, secondBody.audit.replayed].sort()).toEqual([false, true]);

    const [row] = await db.select().from(pendingPayouts).where(eq(pendingPayouts.id, payoutId));
    expect(row?.state).toBe('pending');
  });

  it('does NOT pin a 404 to the key: a failed-again payout is retryable with the same key', async () => {
    const { bearer, stepUp } = await seed();
    const key = idemKey();
    const missingId = crypto.randomUUID();

    const miss = await retryRequest({
      payoutId: missingId,
      bearer,
      stepUp,
      key,
      reason: 'not there yet',
    });
    expect(miss.status).toBe(404);

    // No snapshot was stored for the 404 — the same key must stay
    // usable once a matching failed row exists.
    const snapshots = await db.select().from(adminIdempotencyKeys);
    expect(snapshots).toHaveLength(0);
  });
});

describeIf('admin idempotency guard — corrupt snapshot fails loud', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
  });

  async function postAdjustment(args: {
    targetUserId: string;
    bearer: string;
    stepUp: string;
    key: string;
  }): Promise<Response> {
    return app.request(`http://localhost/api/admin/users/${args.targetUserId}/credit-adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.bearer}`,
        'idempotency-key': args.key,
        'X-Admin-Step-Up': args.stepUp,
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        reason: 'corrupt snapshot test',
      }),
    });
  }

  async function seedSnapshot(args: {
    adminUserId: string;
    key: string;
    targetUserId: string;
    responseBody: string;
  }): Promise<void> {
    await db.insert(adminIdempotencyKeys).values({
      adminUserId: args.adminUserId,
      key: args.key,
      method: 'POST',
      path: `/api/admin/users/${args.targetUserId}/credit-adjustments`,
      status: 200,
      responseBody: args.responseBody,
    });
  }

  it('unparseable stored snapshot → 500 IDEMPOTENCY_SNAPSHOT_CORRUPT and NO write executes', async () => {
    const { adminUserId, targetUser, bearer, stepUp } = await seed();
    const key = idemKey();
    await seedSnapshot({
      adminUserId,
      key,
      targetUserId: targetUser.id,
      responseBody: '{this is not json',
    });

    const res = await postAdjustment({ targetUserId: targetUser.id, bearer, stepUp, key });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_SNAPSHOT_CORRUPT');

    // The financial write must NOT have re-executed.
    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(0);
    const credits = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credits).toHaveLength(0);
  });

  it('empty-object stored snapshot → 500 IDEMPOTENCY_SNAPSHOT_CORRUPT and NO write executes', async () => {
    const { adminUserId, targetUser, bearer, stepUp } = await seed();
    const key = idemKey();
    await seedSnapshot({ adminUserId, key, targetUserId: targetUser.id, responseBody: '{}' });

    const res = await postAdjustment({ targetUserId: targetUser.id, bearer, stepUp, key });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('IDEMPOTENCY_SNAPSHOT_CORRUPT');

    const txRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, targetUser.id));
    expect(txRows).toHaveLength(0);

    // The corrupt row stays in place for ops to inspect.
    const snapshots = await db.select().from(adminIdempotencyKeys);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.responseBody).toBe('{}');
  });
});

describeIf('admin payout-compensation write — fleet-wide daily cap race', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
  });

  it('two truly-concurrent compensations cannot jointly exceed the cap', async () => {
    const previousCap = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
    // 500 each; one fits, two would total 1000 > 700.
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 700n;
    try {
      const { targetUser, bearer, stepUp } = await seed();
      const payoutA = await seedFailedLegacyWithdrawalPayout({
        userId: targetUser.id,
        amountStroops: 500n * 100_000n,
      });
      // Distinct destination so the partial unique index on active
      // withdrawals (user, asset, destination, amount) doesn't reject
      // the second seeded row.
      const payoutB = await seedFailedLegacyWithdrawalPayout({
        userId: targetUser.id,
        amountStroops: 500n * 100_000n,
        toAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      });

      const compensate = async (payoutId: string): Promise<Response> =>
        app.request(`http://localhost/api/admin/payouts/${payoutId}/compensate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'idempotency-key': idemKey(),
            // CF-07: compensate is now step-up-gated.
            'X-Admin-Step-Up': stepUp,
          },
          body: JSON.stringify({ reason: 'concurrent cap race test' }),
        });

      // Genuinely concurrent — both requests are in flight before
      // either resolves. Pre-lock the cap check read `used` without
      // the advisory lock, so both saw 0 and both committed 500.
      const [a, b] = await Promise.all([compensate(payoutA), compensate(payoutB)]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 429]);
      const limited = a.status === 429 ? a : b;
      const limitedBody = (await limited.json()) as { code: string };
      expect(limitedBody.code).toBe('DAILY_LIMIT_EXCEEDED');

      // Exactly one compensation row landed across both payouts.
      const compensationRows = (
        await db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.referenceType, 'payout'))
      ).filter((row) => row.type === 'adjustment');
      expect(compensationRows).toHaveLength(1);

      // Exactly one payout carries the compensated marker.
      const payouts = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.userId, targetUser.id));
      expect(payouts.filter((p) => p.compensatedAt !== null)).toHaveLength(1);

      // Balance bumped once — 500 minor, not 1000.
      const [credit] = await db
        .select()
        .from(userCredits)
        .where(eq(userCredits.userId, targetUser.id));
      expect(credit?.balanceMinor).toBe(500n);
    } finally {
      env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = previousCap;
    }
  });

  it('blocks on the cap advisory lock and honours usage committed while it waited', async () => {
    // Deterministic version of the race above: a manually-held
    // transaction owns the cap lock with an as-yet-uncommitted 500
    // of usage. An unlocked cap check (the pre-fix code) would read
    // used=0 past the holder and commit a second 500; the fixed
    // writer must park on pg_advisory_xact_lock until the holder
    // commits, then see used=500 and reject with 429.
    const previousCap = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 700n;
    try {
      const { targetUser, bearer, stepUp } = await seed();
      const payoutId = await seedFailedLegacyWithdrawalPayout({
        userId: targetUser.id,
        amountStroops: 500n * 100_000n,
      });

      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const lockKey = adjustmentCapLockKey('payout-compensation', 'USD', dayStart);

      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let signalEntered!: () => void;
      const holderEntered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        // Uncommitted usage a lock-less reader cannot see.
        await tx.insert(creditTransactions).values({
          userId: targetUser.id,
          type: 'adjustment',
          amountMinor: 500n,
          currency: 'USD',
          referenceType: 'payout',
          referenceId: crypto.randomUUID(),
          reason: 'simulated concurrent compensation holding the cap lock',
        });
        signalEntered();
        await holderGate;
      });
      await holderEntered;

      const resPromise = Promise.resolve(
        app.request(`http://localhost/api/admin/payouts/${payoutId}/compensate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'idempotency-key': idemKey(),
            // CF-07: compensate is now step-up-gated.
            'X-Admin-Step-Up': stepUp,
          },
          body: JSON.stringify({ reason: 'must wait for the cap lock' }),
        }),
      );
      let settled = false;
      void resPromise.then(() => {
        settled = true;
      });

      // The compensation must still be parked on the advisory lock.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      releaseHolder();
      await holder;

      const res = await resPromise;
      expect(res.status).toBe(429);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('DAILY_LIMIT_EXCEEDED');

      // Only the holder's 500 landed — the cap held.
      const rows = (
        await db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.referenceType, 'payout'))
      ).filter((row) => row.type === 'adjustment');
      expect(rows).toHaveLength(1);
      const [payout] = await db
        .select()
        .from(pendingPayouts)
        .where(eq(pendingPayouts.id, payoutId));
      expect(payout?.compensatedAt).toBeNull();
    } finally {
      env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = previousCap;
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
    await seedFailedLegacyWithdrawalPayout({
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
