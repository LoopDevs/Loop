/**
 * Admin deposit-refund ADR-017 envelope — real-postgres integration
 * test (MNY-13).
 *
 * The A6 deposit-refund handler was the ONLY admin money-move with no
 * ADR-017 envelope: no Idempotency-Key fence, no captured reason, no
 * `admin_idempotency_keys` audit-log row, no Discord ops fanout. Every
 * sibling money-move (order-refund / payout-compensation / emission /
 * credit-adjustment) wraps its mutation in `withIdempotencyGuard` +
 * `buildAuditEnvelope` + `notifyAdminAudit`; this pins that the
 * deposit-refund handler now does the same, end-to-end through real
 * postgres.
 *
 * The refund PRIMITIVE (`payments/deposit-refund.ts::refundDeposit`)
 * carries its OWN on-chain idempotency guard (Horizon memo-scan + CAS
 * claim — covered by `deposit-refund-claim.test.ts`); it is stubbed
 * here to a deterministic, DB-mutating fake so the test isolates the
 * ADMIN-edge fence under test. The fake performs the single real
 * `payment_watcher_skips` state transition (abandoned → refunded) so
 * "exactly one refund state transition" is asserted against real rows,
 * and it counts invocations so the fence's dedup is provable: a
 * same-key replay must NOT re-invoke it.
 *
 * What is REAL: the `withIdempotencyGuard` advisory-lock + snapshot
 * ladder against real postgres, the `admin_idempotency_keys` audit-log
 * row, the `payment_watcher_skips` transition, Hono routing, and the
 * Loop-signed admin auth + step-up path.
 * What is mocked: `refundDeposit` (its own guard is covered elsewhere)
 * and the fire-and-forget Discord notifiers.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

const { refundDepositMock, notifyAdminAuditMock } = vi.hoisted(() => ({
  refundDepositMock: vi.fn(),
  notifyAdminAuditMock: vi.fn(),
}));

// Stub the refund primitive — its on-chain idempotency is covered by
// deposit-refund-claim.test.ts. The implementation (real DB mutation)
// is installed in beforeEach where the `db` import is in scope.
vi.mock('../../payments/deposit-refund.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, refundDeposit: refundDepositMock };
});

// Discord notifiers fire-and-forget after commit; spy on the audit
// fanout, keep the rest as noops so nothing dials a webhook.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    notifyAdminAudit: notifyAdminAuditMock,
    notifyAdminBulkRead: vi.fn(),
    notifyCashbackConfigChanged: vi.fn(),
  };
});

import { db } from '../../db/client.js';
import { paymentWatcherSkips, adminIdempotencyKeys } from '../../db/schema.js';
import { upsertUserFromCtx } from '../../db/users.js';
import { app } from '../../app.js';
import { signLoopToken } from '../../auth/tokens.js';
import { signAdminStepUpToken, type AdminStepUpScope } from '../../auth/admin-step-up.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Random idempotency key (28 base64url chars — above the 16 floor). */
function idemKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('base64url');
}

const TX_HASH = 'simulated-refund-tx';

/**
 * Deterministic stand-in for `refundDeposit` that behaves like the real
 * primitive w.r.t. skip-row state: an `abandoned` row transitions to
 * `refunded` exactly once (the single real state transition); a row
 * already `refunded` converges to `already_refunded` with no further
 * transition; a missing row is `not_found`.
 */
async function fakeRefundDeposit(
  paymentId: string,
): Promise<{ kind: string; txHash?: string; detail?: string }> {
  const [row] = await db
    .select({ status: paymentWatcherSkips.status, refundTxHash: paymentWatcherSkips.refundTxHash })
    .from(paymentWatcherSkips)
    .where(eq(paymentWatcherSkips.paymentId, paymentId));
  if (row === undefined) return { kind: 'not_found' };
  if (row.status === 'refunded') {
    return { kind: 'already_refunded', txHash: row.refundTxHash ?? '' };
  }
  const txHash = `${TX_HASH}-${paymentId}`;
  await db
    .update(paymentWatcherSkips)
    .set({ status: 'refunded', refundTxHash: txHash, updatedAt: sql`NOW()` })
    .where(eq(paymentWatcherSkips.paymentId, paymentId));
  return { kind: 'refunded', txHash };
}

interface SeededAdmin {
  adminUserId: string;
  bearer: string;
  // SEC-02-stepup: mint a FRESH single-use, class-bound token per request
  // (the deposit-refund endpoint gates on the `deposit-refund` scope).
  mintStepUp: (scope: AdminStepUpScope) => string;
}

async function seedAdmin(): Promise<SeededAdmin> {
  const admin = await upsertUserFromCtx({ ctxUserId: 'test-admin-id', email: 'admin@test.local' });
  const { token } = signLoopToken({
    sub: admin.id,
    email: admin.email,
    typ: 'access',
    ttlSeconds: 300,
  });
  const mintStepUp = (scope: AdminStepUpScope): string =>
    signAdminStepUpToken({ sub: admin.id, email: admin.email, scope }).token;
  return { adminUserId: admin.id, bearer: token, mintStepUp };
}

async function seedAbandonedSkip(paymentId: string): Promise<void> {
  await db.insert(paymentWatcherSkips).values({
    paymentId,
    memo: 'MEMO',
    reason: 'order_gone',
    payment: { id: paymentId, type: 'payment', from: 'GSENDER', amount: '1.0000000' },
    status: 'abandoned',
  });
}

function headersFor(
  bearer: string,
  mintStepUp: (scope: AdminStepUpScope) => string,
  key: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer}`,
    'idempotency-key': key,
    // SEC-02-stepup: fresh single-use deposit-refund token per call.
    'X-Admin-Step-Up': mintStepUp('deposit-refund'),
  };
}

describeIf('admin deposit-refund — ADR-017 envelope (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    refundDepositMock.mockReset();
    refundDepositMock.mockImplementation(fakeRefundDeposit);
    notifyAdminAuditMock.mockReset();
  });

  it('wraps the refund in the envelope: one transition + audit-log row + captured reason + fanout, and a same-key replay is fenced', async () => {
    const { adminUserId, bearer, mintStepUp } = await seedAdmin();
    const paymentId = 'op-refund-1';
    await seedAbandonedSkip(paymentId);

    const key = idemKey();
    const reason = 'operator refund — late deposit, order expired';
    const url = `http://localhost/api/admin/deposits/${paymentId}/refund`;
    const body = JSON.stringify({ reason });

    // ---- First write ---- (SEC-02-stepup: fresh single-use token; the
    // idempotency replay below mints its own, same key.)
    const first = await app.request(url, {
      method: 'POST',
      headers: headersFor(bearer, mintStepUp, key),
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      result: { paymentId: string; status: string; txHash: string; reason: string };
      audit: { replayed: boolean; idempotencyKey: string; actorUserId: string };
    };
    // ADR-017 envelope shape (was a bare { paymentId, status, txHash }).
    expect(firstBody.result.status).toBe('refunded');
    expect(firstBody.result.txHash).toBe(`${TX_HASH}-${paymentId}`);
    expect(firstBody.result.reason).toBe(reason);
    expect(firstBody.audit.replayed).toBe(false);
    expect(firstBody.audit.idempotencyKey).toBe(key);
    expect(firstBody.audit.actorUserId).toBe(adminUserId);

    // Exactly ONE refund state transition.
    const [skip] = await db
      .select()
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    expect(skip?.status).toBe('refunded');
    expect(skip?.refundTxHash).toBe(`${TX_HASH}-${paymentId}`);
    expect(refundDepositMock).toHaveBeenCalledTimes(1);

    // Audit-log row (the durable admin-write trail audit-tail.ts reads).
    const auditRows = await db
      .select()
      .from(adminIdempotencyKeys)
      .where(
        and(eq(adminIdempotencyKeys.adminUserId, adminUserId), eq(adminIdempotencyKeys.key, key)),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.method).toBe('POST');
    expect(auditRows[0]!.path).toBe(`/api/admin/deposits/${paymentId}/refund`);
    expect(auditRows[0]!.status).toBe(200);
    // Captured reason durably persisted on the audit-log snapshot.
    expect(auditRows[0]!.responseBody).toContain(reason);

    // Discord ops fanout fired once, carrying the reason.
    expect(notifyAdminAuditMock).toHaveBeenCalledTimes(1);
    expect(notifyAdminAuditMock.mock.calls[0]![0]).toMatchObject({
      actorUserId: adminUserId,
      endpoint: `POST /api/admin/deposits/${paymentId}/refund`,
      reason,
      idempotencyKey: key,
      replayed: false,
    });

    // ---- Replay with the SAME key: the ADR-017 fence dedups ----
    // A fresh single-use step-up token (same idempotency key) so the
    // replay is decided at the idempotency fence, not the step-up gate.
    const second = await app.request(url, {
      method: 'POST',
      headers: headersFor(bearer, mintStepUp, key),
      body,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      result: unknown;
      audit: { replayed: boolean };
    };
    expect(secondBody.audit.replayed).toBe(true);
    expect(secondBody.result).toEqual(firstBody.result);

    // The fence prevented a SECOND invocation of the refund primitive —
    // still exactly one transition, still one audit-log row.
    expect(refundDepositMock).toHaveBeenCalledTimes(1);
    const auditRowsAfter = await db
      .select()
      .from(adminIdempotencyKeys)
      .where(
        and(eq(adminIdempotencyKeys.adminUserId, adminUserId), eq(adminIdempotencyKeys.key, key)),
      );
    expect(auditRowsAfter).toHaveLength(1);
    // The replay still fans out (ADR-017 "🔁 replayed" embed), flagged.
    expect(notifyAdminAuditMock).toHaveBeenCalledTimes(2);
    expect(notifyAdminAuditMock.mock.calls[1]![0]).toMatchObject({ replayed: true });
  });

  it('requires an Idempotency-Key header (400) and does not invoke the refund', async () => {
    const { bearer, mintStepUp } = await seedAdmin();
    const paymentId = 'op-refund-2';
    await seedAbandonedSkip(paymentId);

    const res = await app.request(`http://localhost/api/admin/deposits/${paymentId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'X-Admin-Step-Up': mintStepUp('deposit-refund'),
      },
      body: JSON.stringify({ reason: 'no idempotency key' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(refundDepositMock).not.toHaveBeenCalled();
    const [skip] = await db
      .select()
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    expect(skip?.status).toBe('abandoned');
  });

  it('requires a captured reason (400) and does not invoke the refund', async () => {
    const { bearer, mintStepUp } = await seedAdmin();
    const paymentId = 'op-refund-3';
    await seedAbandonedSkip(paymentId);

    const res = await app.request(`http://localhost/api/admin/deposits/${paymentId}/refund`, {
      method: 'POST',
      headers: headersFor(bearer, mintStepUp, idemKey()),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
    expect(refundDepositMock).not.toHaveBeenCalled();
    const [skip] = await db
      .select()
      .from(paymentWatcherSkips)
      .where(eq(paymentWatcherSkips.paymentId, paymentId));
    expect(skip?.status).toBe('abandoned');
  });
});
