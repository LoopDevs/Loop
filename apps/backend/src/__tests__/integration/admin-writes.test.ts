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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
  otpAttemptCounters,
} from '../../db/schema.js';
import { findOrCreateUserByEmail, upsertUserFromCtx } from '../../db/users.js';
import { app, __resetRateLimitsForTests } from '../../app.js';
import { notifyAdminBulkRead } from '../../discord.js';
import { signLoopToken } from '../../auth/tokens.js';
import { signAdminStepUpToken, type AdminStepUpScope } from '../../auth/admin-step-up.js';
import { adjustmentCapLockKey, DailyAdjustmentLimitError } from '../../credits/adjustments.js';
import { CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY } from '../../admin/clear-otp-lockout.js';
import { applyAdminEmission } from '../../credits/emissions.js';
import { env } from '../../env.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

/** Random idempotency key (28 base64url chars — well above the 16 floor). */
function idemKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('base64url');
}

/**
 * MNY-10: the target user's registered wallet. `seed()` provisions this
 * as the target's ACTIVATED embedded wallet, so an emission whose
 * `destinationAddress` equals it is pinned + accepted, and any other
 * address is rejected (`DESTINATION_NOT_REGISTERED`). Every emission
 * test in this file targets this address (the historic all-`A` literal
 * the pre-fix tests already used), so the pinning guard is a no-op for
 * the correctly-addressed happy paths and a hard gate for the rest.
 */
const TARGET_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
   *
   * SEC-02-stepup: step-up tokens are now SINGLE-USE and CLASS-BOUND, so
   * one pre-minted wildcard token can no longer be replayed across writes.
   * `mintStepUp(scope)` mints a FRESH token scoped to exactly the action
   * a given request guards; each protected request (including each side
   * of an idempotency replay / concurrency race) mints its own.
   */
  mintStepUp: (scope: AdminStepUpScope) => string;
  orderId: string;
}

async function seedCashbackBalance(args: {
  userId: string;
  currency?: 'USD' | 'GBP' | 'EUR';
  amountMinor: bigint;
}): Promise<void> {
  const currency = args.currency ?? 'USD';
  // DAT-01-inv1 (migration 0066): the cashback ledger row and the
  // matching balance must land in ONE transaction so the deferred
  // mirror-invariant trigger sees an EQUAL mirror at commit (previously
  // the two autocommitted separately, tripping the constraint). Backing
  // type stays 'cashback' with an order reference — a cashback-derived
  // balance is what these emission fixtures model.
  await seedUserCreditsWithBackingLedger(db, {
    userId: args.userId,
    currency,
    balanceMinor: args.amountMinor,
    type: 'cashback',
    reason: null,
    referenceType: 'order',
    referenceId: crypto.randomUUID(),
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
  //
  // DAT-01-inv1 (migration 0066): pre-ADR-036 the at-send debit was a
  // MATCHED write (the withdrawal ledger row AND a balance decrement,
  // drawn against the credits that funded it) — never one-sided. A lone
  // `-X` debit would unbalance the mirror against the separately-seeded
  // balance. So seed the debit together with the `+X` funding credit it
  // was drawn against, in ONE transaction: the pair is net-zero to the
  // ledger, so whatever balance the caller seeded stays consistent
  // (balance 0 → ledger 0; a prior cashback balance stays equal to it).
  const debitMinor = args.amountStroops / 100_000n;
  await db.transaction(async (tx) => {
    await tx.insert(creditTransactions).values({
      userId: args.userId,
      type: 'adjustment',
      amountMinor: debitMinor,
      currency: 'USD',
      referenceType: null,
      referenceId: null,
      reason: 'funding credit for the legacy at-send debit (test seed)',
    });
    await tx.insert(creditTransactions).values({
      userId: args.userId,
      type: 'withdrawal',
      amountMinor: -debitMinor,
      currency: 'USD',
      referenceType: 'payout',
      referenceId: row.id,
      reason: 'seeded legacy at-send debit (pre-ADR-036)',
    });
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
    // NS-09: stamp the seeded admin's current token_version (0) so
    // requireAuth's revocation check admits the bearer.
    tv: admin.tokenVersion,
  });
  // SEC-02-stepup: mint fresh, class-bound single-use tokens on demand.
  const mintStepUp = (scope: AdminStepUpScope): string =>
    signAdminStepUpToken({ sub: admin.id, email: admin.email, scope }).token;
  const target = await findOrCreateUserByEmail('target@test.local');
  // MNY-10: give the target an ACTIVATED embedded wallet so emissions
  // pinned to it (`destinationAddress === TARGET_WALLET`) are accepted.
  // Non-emission writes (credit-adjust / refund) ignore these columns.
  await db
    .update(users)
    .set({ homeCurrency: 'USD', walletProvisioning: 'activated', walletAddress: TARGET_WALLET })
    .where(eq(users.id, target.id));

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
    mintStepUp,
    orderId: orderRow.id,
  };
}

// SEC-02-stepup: end-to-end proof through the REAL Hono app + REAL
// middleware + REAL consume that the step-up token is (1) class-bound —
// a token minted for action A is rejected on action B's endpoint — and
// (2) single-use — the same token replayed against its own endpoint is
// rejected. This is the audited "one token → any write, unlimited times"
// hole, closed at the live request path.
describeIf(
  'SEC-02-stepup: admin step-up gate is class-bound + single-use (HTTP end-to-end)',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });
    beforeEach(async () => {
      await truncateAllTables();
    });

    it('rejects a token minted for a DIFFERENT action class (emission token on the credit-adjust endpoint) → STEP_UP_PURPOSE_MISMATCH', async () => {
      const { targetUser, bearer, mintStepUp } = await seed();
      const res = await app.request(
        `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'idempotency-key': idemKey(),
            // Minted to queue an EMISSION; replayed against a credit-adjust.
            'X-Admin-Step-Up': mintStepUp('emission'),
          },
          body: JSON.stringify({
            amountMinor: '500',
            currency: 'USD',
            reason: 'wrong-class replay',
          }),
        },
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_PURPOSE_MISMATCH');

      // The wrong-class presentation wrote nothing — no ledger row.
      const txRows = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, targetUser.id));
      expect(txRows).toHaveLength(0);
    });

    it('is single-use: replaying the SAME token against its own endpoint → STEP_UP_ALREADY_USED', async () => {
      const { targetUser, bearer, mintStepUp } = await seed();
      const token = mintStepUp('credit-adjustment');
      const url = `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`;
      const headersWith = (key: string): Record<string, string> => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': key,
        'X-Admin-Step-Up': token,
      });

      // First use of the token — passes step-up, applies the write.
      const first = await app.request(url, {
        method: 'POST',
        headers: headersWith(idemKey()),
        body: JSON.stringify({ amountMinor: '500', currency: 'USD', reason: 'first use' }),
      });
      expect(first.status).toBe(200);

      // Same token, DIFFERENT idempotency key (so the idempotency fence
      // can't mask it): the single-use consume rejects the replay.
      const second = await app.request(url, {
        method: 'POST',
        headers: headersWith(idemKey()),
        body: JSON.stringify({ amountMinor: '300', currency: 'USD', reason: 'replayed token' }),
      });
      expect(second.status).toBe(401);
      expect(((await second.json()) as { code: string }).code).toBe('STEP_UP_ALREADY_USED');

      // Only the FIRST write landed — the replay never reached the handler.
      const txRows = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.userId, targetUser.id));
      expect(txRows).toHaveLength(1);
      expect(txRows[0]!.amountMinor).toBe(500n);
    });
  },
);

describeIf('admin credit-adjustment write — real postgres ladder', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  // Hardening C7: every admin money write in this suite must leave the
  // mirror consistent with the credit_transactions sum. See
  // flywheel.test.ts for the rationale.
  afterEach(async () => {
    expect(await computeLedgerDriftSql(db)).toEqual([]);
  });

  it('credit happy path: writes ledger row + bumps balance + returns envelope', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    const key = idemKey();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': key,
          'X-Admin-Step-Up': mintStepUp('credit-adjustment'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
    const key = idemKey();
    const body = JSON.stringify({
      amountMinor: '300',
      currency: 'USD',
      reason: 'replay test',
    });
    // SEC-02-stepup: each request mints its own single-use, class-bound
    // token — the idempotency replay is proven at the idempotency layer,
    // so both requests must first pass step-up with a fresh token.
    const headers = (): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      'X-Admin-Step-Up': mintStepUp('credit-adjustment'),
    });
    const url = `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`;
    const first = await app.request(url, { method: 'POST', headers: headers(), body });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { audit: { replayed: boolean }; result: unknown };
    expect(firstBody.audit.replayed).toBe(false);

    const second = await app.request(url, { method: 'POST', headers: headers(), body });
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
    const { targetUser, bearer, mintStepUp } = await seed();
    // Target user has a $0 balance. Try to debit $5.
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/credit-adjustments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': mintStepUp('credit-adjustment'),
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
      const { bearer, targetUser, mintStepUp } = await seed();
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
              'X-Admin-Step-Up': mintStepUp('credit-adjustment'),
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
    const { targetUser, bearer, mintStepUp, orderId } = await seed();
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        // CF-06: refund is now step-up-gated like its sibling writers.
        'X-Admin-Step-Up': mintStepUp('refund'),
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
    const { targetUser, bearer, mintStepUp, orderId } = await seed();
    const url = `http://localhost/api/admin/users/${targetUser.id}/refunds`;
    const headers = (key: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      // CF-06: refund is now step-up-gated like its sibling writers.
      'X-Admin-Step-Up': mintStepUp('refund'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
    // The unbacked-emission guard requires an existing mirror
    // balance >= the emitted amount. Pre-seed a cashback ledger row +
    // matching user_credits balance in ONE transaction so the
    // DAT-01-inv1 mirror invariant (migration 0066) holds at commit.
    await seedUserCreditsWithBackingLedger(db, {
      userId: targetUser.id,
      currency: 'USD',
      balanceMinor: 2000n,
      type: 'cashback',
      reason: null,
      referenceType: 'order',
      referenceId: '00000000-0000-0000-0000-000000000001',
    });

    const destinationAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
        'X-Admin-Step-Up': mintStepUp('emission'),
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
        'X-Admin-Step-Up': mintStepUp('emission'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
    // SEC-02-stepup: step-up is single-use, so each concurrent request
    // carries its OWN fresh emission-scoped token — both pass step-up
    // (distinct jtis) and then genuinely contend at the idempotency-key
    // layer, which is what this test proves.
    const headers = (): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': idempotencyKey,
      'X-Admin-Step-Up': mintStepUp('emission'),
    });

    // Fire both requests before awaiting either so they genuinely
    // contend on the idempotency-key row inside the writer's
    // transaction, rather than running back-to-back.
    const firstPromise = app.request(url, { method: 'POST', headers: headers(), body });
    const secondPromise = app.request(url, { method: 'POST', headers: headers(), body });
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
    const { targetUser, bearer, mintStepUp } = await seed();
    // No prior balance. Try to emit $5 — would mint unbacked LOOP.
    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
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

  // ── MNY-10: emission destination pinned to the registered wallet ──
  //
  // The disease: `destinationAddress` was trusted as free admin input,
  // so a typo'd/malicious value queued an on-chain LOOP payment to an
  // address the target user does not control. The handler now resolves
  // the user's registered wallet (activated embedded wallet, else the
  // legacy linked stellarAddress — mirroring the cashback payout
  // builder) and rejects any other destination.
  it('MNY-10: rejects an emission to a destination that is NOT the registered wallet (400 DESTINATION_NOT_REGISTERED)', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    // Fully-funded + otherwise valid — the ONLY defect is that the
    // destination differs from the user's registered wallet. A valid,
    // well-formed G-address that is not TARGET_WALLET.
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });
    const attackerDest = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
    expect(attackerDest).not.toBe(TARGET_WALLET);

    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress: attackerDest,
        reason: 'MNY-10: unregistered destination must be refused',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DESTINATION_NOT_REGISTERED');

    // The disease-proof: NOTHING was queued to the wrong address.
    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(0);
    // Mirror untouched; no ledger row written.
    const [credit] = await db
      .select()
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);
  });

  it('MNY-10: accepts an emission pinned to the registered wallet; queues the payout to that address', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress: TARGET_WALLET,
        reason: 'MNY-10: registered destination is accepted',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { payoutId: string; destinationAddress: string } };
    expect(body.result.destinationAddress).toBe(TARGET_WALLET);

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, body.result.payoutId));
    expect(payouts).toHaveLength(1);
    // Pinned to the DB-authoritative registered wallet.
    expect(payouts[0]!.toAddress).toBe(TARGET_WALLET);
  });

  it('MNY-10: rejects an emission when the target user has NO registered wallet (400 NO_REGISTERED_WALLET)', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    // Strip the wallet seed() provisioned — model a user who never
    // linked/activated a wallet. The safe default is to refuse rather
    // than pay a free-input destination.
    await db
      .update(users)
      .set({ walletProvisioning: 'none', walletAddress: null, stellarAddress: null })
      .where(eq(users.id, targetUser.id));
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress: TARGET_WALLET,
        reason: 'MNY-10: no registered wallet must be refused',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_REGISTERED_WALLET');

    const payouts = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(0);
  });

  it('MNY-10: for an embedded-wallet-only user, the activated embedded wallet is the pin — a legacy stellarAddress destination is refused', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    // Activated embedded wallet = TARGET_WALLET (from seed()), PLUS a
    // distinct legacy linked address. Resolution mirrors the cashback
    // builder: the activated embedded wallet wins, so an emission to
    // the legacy address must be refused.
    const legacyAddr = 'GCZERWKF5DJUM33F5EPGQNS3EL6KLC4CDZ7LR7WVU2CHKGNGZ5V4B7QI';
    expect(legacyAddr).not.toBe(TARGET_WALLET);
    await db.update(users).set({ stellarAddress: legacyAddr }).where(eq(users.id, targetUser.id));
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const res = await app.request(`http://localhost/api/admin/users/${targetUser.id}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('emission'),
      },
      body: JSON.stringify({
        amountMinor: '500',
        currency: 'USD',
        destinationAddress: legacyAddr,
        reason: 'MNY-10: activated embedded wallet takes precedence',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('DESTINATION_NOT_REGISTERED');
  });

  it('ADR 036: compensation refuses a debit-less post-ADR-036 emission with 409', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
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
        'X-Admin-Step-Up': mintStepUp('payout-compensation'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
            'X-Admin-Step-Up': mintStepUp('payout-retry'),
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
            'X-Admin-Step-Up': mintStepUp('payout-compensation'),
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
    mintStepUp: (scope: AdminStepUpScope) => string;
    amountMinor: string;
    /** Defaults to 'USD' (→ USDLOOP). P2-f's interest_mint case needs 'GBP' (→ GBPLOOP, the only interest_mint-eligible asset — see the kind_shape CHECK). */
    currency?: 'USD' | 'GBP' | 'EUR';
  }): Promise<Response> {
    return app.request(`http://localhost/api/admin/users/${args.userId}/emissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.bearer}`,
        'idempotency-key': idemKey(),
        // SEC-02-stepup: fresh single-use emission token per call.
        'X-Admin-Step-Up': args.mintStepUp('emission'),
      },
      body: JSON.stringify({
        amountMinor: args.amountMinor,
        currency: args.currency ?? 'USD',
        destinationAddress: DEST,
        reason: 'conservation integration test',
      }),
    });
  }

  it('rejects cumulative emissions past the liability — the audited unbacked-mint hole', async () => {
    // THE finding: each call passes `balance >= amount` because
    // emission never debits, so before A1 an admin could emit 1500,
    // then 800, then 800… against a 2000 balance forever.
    const { targetUser, bearer, mintStepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const first = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '1500' });
    expect(first.status).toBe(200);

    const second = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '800' });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; message: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');
    expect(body.message).toContain('500'); // remaining headroom named for the operator

    // Exactly the remaining headroom still emits fine.
    const third = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '500' });
    expect(third.status).toBe(200);
  });

  // ── MNY-11-EMISSION-HARDENING: first-line amount-consistency guard ──
  // The primitive takes `amountMinor` (drives the balance + conservation
  // fences) AND `intent.amountStroops` (the amount actually minted, the
  // daily cap's checked amount, and what the 0044/0061 trigger measures)
  // as INDEPENDENT caller inputs. A small `amountMinor` paired with a
  // large `amountStroops` clears the minor-denominated fences while
  // minting the large stroops. These tests call the primitive DIRECTLY
  // (the HTTP handler always derives `amountStroops = amountMinor *
  // 100_000n`, so the hole is only reachable at the primitive boundary).
  const HARDENING_ISSUER = 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('MNY-11-HARDENING: rejects an inconsistent intent (small amountMinor, large amountStroops) at entry — no mint, balance untouched', async () => {
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    // amountMinor=1 clears the balance guard (1 ≤ 2000) and the
    // conservation check (0 + 1 ≤ 2000), but the intent would mint 1500
    // minor of stroops — WITHIN the 2000 balance, so the 0044/0061
    // conservation trigger would ALSO pass (1500 ≤ 2000). Pre-fix the
    // mint proceeds and a real pending_payouts row lands; the guard is
    // the only thing that catches this at the app boundary.
    let thrown: unknown = null;
    try {
      await applyAdminEmission({
        userId: targetUser.id,
        currency: 'USD',
        amountMinor: 1n,
        intent: {
          assetCode: 'USDLOOP',
          assetIssuer: HARDENING_ISSUER,
          toAddress: TARGET_WALLET,
          amountStroops: 1500n * 100_000n, // 1500 minor — 1500× the checked minor
          memoText: 'mny11-hardening-red',
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/inconsistent caller amounts/);

    // No mint: zero pending_payouts rows for the user.
    const payouts = await db
      .select({ id: pendingPayouts.id })
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(0);

    // Mirror balance unchanged (emission never debits anyway, but the
    // rejection must not have written any side effect).
    const [credit] = await db
      .select({ balanceMinor: userCredits.balanceMinor })
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);

    // No emission-referencing ledger row (only the seeded cashback row).
    const emissionTx = await db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.referenceType, 'payout'));
    expect(emissionTx).toHaveLength(0);
  });

  it('MNY-11-HARDENING: rejects a sub-minor (non-integral) stroops amount at entry', async () => {
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    // 150_000 stroops = 1.5 minor; floor(150_000 / 100_000) = 1 = the
    // supplied amountMinor, so the equality alone would pass — the
    // whole-minor modulo guard is what rejects the half-minor remainder.
    let thrown: unknown = null;
    try {
      await applyAdminEmission({
        userId: targetUser.id,
        currency: 'USD',
        amountMinor: 1n,
        intent: {
          assetCode: 'USDLOOP',
          assetIssuer: HARDENING_ISSUER,
          toAddress: TARGET_WALLET,
          amountStroops: 150_000n,
          memoText: 'mny11-hardening-frac',
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/whole-minor/);

    const payouts = await db
      .select({ id: pendingPayouts.id })
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(0);
  });

  it('MNY-11-HARDENING: a CONSISTENT intent still succeeds — no false-reject of legitimate emissions', async () => {
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    const result = await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 1500n,
      intent: {
        assetCode: 'USDLOOP',
        assetIssuer: HARDENING_ISSUER,
        toAddress: TARGET_WALLET,
        amountStroops: 1500n * 100_000n, // consistent: 1500 minor
        memoText: 'mny11-hardening-green',
      },
    });
    expect(result.amountMinor).toBe(1500n);

    const payouts = await db
      .select({ kind: pendingPayouts.kind, amountStroops: pendingPayouts.amountStroops })
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.kind).toBe('emission');
    expect(payouts[0]!.amountStroops).toBe(1500n * 100_000n);

    // Mirror still untouched (ADR 036).
    const [credit] = await db
      .select({ balanceMinor: userCredits.balanceMinor })
      .from(userCredits)
      .where(eq(userCredits.userId, targetUser.id));
    expect(credit?.balanceMinor).toBe(2000n);
  });

  it('a CONFIRMED prior mint consumes headroom — its liability is already on-chain', async () => {
    // Seeded as a confirmed emission row: the conservation accounting
    // treats the three mint kinds (order_cashback / emission /
    // interest_mint) through one uniform IN-clause, and the kind-shape
    // CHECK requires order_cashback rows to carry a real order — the
    // state coverage (confirmed counts, failed doesn't) is what these
    // two tests pin.
    const { targetUser, bearer, mintStepUp } = await seed();
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

    const res = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'EMISSION_EXCEEDS_UNEMITTED_BALANCE',
    );
  });

  it('CONV-MNY-01: a SHARED-MIRROR over-emission (prior LOOPUSD ate the USD headroom, handler emits USDLOOP) is a typed 409, NOT an opaque 500', async () => {
    // CONV-MNY-01. USDLOOP and LOOPUSD BOTH map to the one 'USD'
    // `user_credits` mirror (`loop_asset_mirror_currency`, migration
    // 0061), so they draw from a SINGLE pool of emission headroom. The
    // DB conservation trigger (`assert_emission_conservation`, migrations
    // 0044/0061) scopes its minted-sum by MIRROR CURRENCY. The app-layer
    // pre-check in `applyAdminEmission` (`emittedNetMinorFor`) must scope
    // its sum the SAME way: if it summed by the bare `asset_code`, a
    // USDLOOP emission would not "see" a prior LOOPUSD emission, would
    // sail past the app fence, and would only be caught at the trigger —
    // surfacing to the operator as an untyped 500 from the generic
    // catch-all rather than the intended typed 409
    // EMISSION_EXCEEDS_UNEMITTED_BALANCE. The existing "CONFIRMED prior
    // mint consumes headroom" test above uses USDLOOP on BOTH sides, so
    // it passes under EITHER scoping and does not guard this hole; this
    // test drives the CROSS-asset shared-mirror path end-to-end through
    // the HTTP handler and pins the 409.
    const { targetUser, bearer, mintStepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    // A confirmed prior emission on the SIBLING mirror-sharing asset —
    // LOOPUSD, NOT the USDLOOP the handler will emit — that already
    // consumes the ENTIRE 2000-minor USD headroom. `confirmed` counts
    // toward the minted total; the raw insert itself is admitted by the
    // trigger because minted 2000 ≤ balance 2000.
    await db.insert(pendingPayouts).values({
      userId: targetUser.id,
      kind: 'emission',
      assetCode: 'LOOPUSD',
      assetIssuer: 'CLOOPUSDVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: DEST,
      amountStroops: 2000n * 100_000n,
      memoText: 'seeded confirmed LOOPUSD emission (shares USD mirror)',
      state: 'confirmed',
    });

    // Now emit via the handler (currency USD → USDLOOP) for 1 more
    // minor. The shared USD headroom is already fully consumed by the
    // LOOPUSD row above, so the mirror-currency-scoped app fence must
    // reject this BEFORE the DB trigger would — mapping to a typed 409.
    const res = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '1' });

    // The whole point of the finding: a typed 409, never an opaque 500.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');
    // Message names the balance + already-emitted totals for the
    // operator (2000 balance minus 2000 already materialised on-chain
    // leaves 0 available).
    expect(body.message).toContain('2000');

    // No side effects: the rejected USDLOOP emission wrote nothing — the
    // only emission row for the user is the seeded LOOPUSD one.
    const rows = await db
      .select({ assetCode: pendingPayouts.assetCode })
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetCode).toBe('LOOPUSD');
  });

  it('a FAILED prior mint does NOT consume headroom — the backfill use case emission exists for', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
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

    const res = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '2000' });
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
    const backfill = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '2000' });
    expect(backfill.status).toBe(200);

    // Retrying the original failed row would mint BOTH → 409.
    const retry = await app.request(`http://localhost/api/admin/payouts/${failedRow!.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('payout-retry'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
        'X-Admin-Step-Up': mintStepUp('payout-retry'),
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

  // P2-f (docs/money-auth-worklist.md / audit-2026-07-09-money-auth-sweep.md
  // P2 findings — credits): migration 0044's INSERT-side trigger only
  // WHENs on kind='emission' — a fresh order_cashback/interest_mint
  // INSERT moves the mirror atomically in the same app-layer txn, so it
  // doesn't need the DB fence at insert time (see the migration's own
  // header comment). The UPDATE-side "re-entry" trigger, however, WHENs
  // on all three mint kinds (`OLD.state = 'failed' AND NEW.state !=
  // 'failed'`) — that's the real double-mint vector for order_cashback
  // and interest_mint too (a failed fulfilment-cashback or interest-mint
  // row whose headroom was re-consumed by a backfill while it sat
  // failed). Only the kind='emission' case had direct coverage before
  // this — these two tests close that gap by mirroring the
  // 'retry-after-backfill double mint' case above for the other two
  // kinds the same trigger gates.
  it('retry-after-backfill double mint is rejected by the re-entry trigger for kind=order_cashback (P2-f)', async () => {
    const { targetUser, bearer, mintStepUp, orderId } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 2000n });

    // The original fulfilment-time cashback payout, terminally failed.
    // kind_shape requires order_cashback rows to carry a real order id —
    // reuse the seeded order (its `state` is irrelevant to the FK/CHECK).
    const [failedRow] = await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        orderId,
        kind: 'order_cashback',
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: 2000n * 100_000n,
        memoText: 'original order_cashback, terminally failed',
        state: 'failed',
        lastError: 'op_no_trust',
        attempts: 5,
      })
      .returning({ id: pendingPayouts.id });

    // The backfill — a different mint kind (emission), same user/asset —
    // legitimately consumes the full headroom. The trigger sums all
    // three mint kinds together, so this is exactly the cross-kind
    // double-mint shape the fence must catch.
    const backfill = await emit({ userId: targetUser.id, bearer, mintStepUp, amountMinor: '2000' });
    expect(backfill.status).toBe(200);

    // Retrying the original failed order_cashback row would mint BOTH → 409.
    const retry = await app.request(`http://localhost/api/admin/payouts/${failedRow!.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('payout-retry'),
      },
      body: JSON.stringify({ reason: 'attempting the double-mint retry (order_cashback)' }),
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

  it('retry-after-backfill double mint is rejected by the re-entry trigger for kind=interest_mint (P2-f)', async () => {
    // interest_mint rows are GBPLOOP-only (kind_shape CHECK: kind !=
    // 'interest_mint' OR asset_code = 'GBPLOOP') — seed the balance and
    // the backfill emission in GBP to match.
    const { targetUser, bearer, mintStepUp } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, currency: 'GBP', amountMinor: 2000n });

    const [failedRow] = await db
      .insert(pendingPayouts)
      .values({
        userId: targetUser.id,
        kind: 'interest_mint',
        assetCode: 'GBPLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: 2000n * 100_000n,
        memoText: 'original interest_mint, terminally failed',
        state: 'failed',
        lastError: 'op_no_trust',
        attempts: 5,
      })
      .returning({ id: pendingPayouts.id });

    const backfill = await emit({
      userId: targetUser.id,
      bearer,
      mintStepUp,
      amountMinor: '2000',
      currency: 'GBP',
    });
    expect(backfill.status).toBe(200);

    const retry = await app.request(`http://localhost/api/admin/payouts/${failedRow!.id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': mintStepUp('payout-retry'),
      },
      body: JSON.stringify({ reason: 'attempting the double-mint retry (interest_mint)' }),
    });
    expect(retry.status).toBe(409);
    const body = (await retry.json()) as { code: string };
    expect(body.code).toBe('EMISSION_EXCEEDS_UNEMITTED_BALANCE');

    const [row] = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, failedRow!.id));
    expect(row?.state).toBe('failed');
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

  it('MNY-11: an understated amountMinor cannot slip a large amountStroops past the guards — now rejected at entry by the hardening consistency check', async () => {
    // The primitive is the trust boundary (the HTTP handler always sets
    // amountStroops = amountMinor * 100_000, but a future/rogue internal
    // caller — or a handler bug — need not). Cap default is 100M minor.
    //
    // Attack: understate `amountMinor` to 1 (slips under the cap) while
    // minting `amountStroops` worth 150M minor (over the cap). The mirror
    // balance is 200M minor so the per-call balance guard AND the
    // conservation fence PASS — the ONLY thing that could wave this
    // through is a fence reading the understated minor.
    //
    // Layering history:
    //  - Before MNY-11-emissioncap the DAILY CAP read the caller's
    //    amountMinor (1) → passed → the 150M-minor emission was queued.
    //    That fix rebound the cap to `amountStroops / 100_000`.
    //  - MNY-11-EMISSION-HARDENING then added a FIRST-LINE consistency
    //    guard at the top of the primitive: any intent whose amountMinor
    //    ≠ amountStroops / 100_000 is rejected BEFORE the balance,
    //    conservation, or cap fences run. So this inconsistent intent now
    //    fails at entry — a strictly earlier, stronger rejection than the
    //    cap. (The cap-binds-to-minted-stroops property for CONSISTENT
    //    emissions is still proven by the `fleet-wide daily emission cap`
    //    sibling test above, which uses matched minor/stroops.)
    //
    // The MONEY-SAFETY invariant under test is unchanged: an understated
    // minor CANNOT queue a large-stroops mint. Only the rejecting layer
    // (and thus the error type) moved earlier.
    const { targetUser } = await seed();
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 200_000_000n });

    const understatedMinor = 1n;
    const mintedStroops = 150_000_000n * 100_000n; // 150M minor actually minted

    let thrown: unknown = null;
    const applied = await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: understatedMinor,
      intent: {
        assetCode: 'USDLOOP',
        assetIssuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAddress: DEST,
        amountStroops: mintedStroops,
        memoText: 'mny-11 cap bypass',
      },
    }).catch((err: unknown) => {
      thrown = err;
      return null;
    });

    // The inconsistent intent is refused, not queued on the strength of
    // the understated minor. Post-hardening the FIRST-LINE consistency
    // guard is what rejects it (before the cap ever runs); pin that exact
    // message so this stays a precise, non-vacuous assertion.
    expect(applied).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/inconsistent caller amounts/);

    // Bypass provably closed: NO emission row was queued — the caller
    // could not mint 150M minor of on-chain value with a minor of 1.
    const queued = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(queued).toHaveLength(0);
  });

  it('MNY-11-CAPSCOPE: the daily cap is PER MIRROR CURRENCY — splitting across two asset codes that share a mirror cannot double it', async () => {
    // Cap default is 100M minor, declared PER CURRENCY
    // (`ADMIN_DAILY_WITHDRAWAL_CAP_MINOR`; the OpenAPI contract calls it
    // "a fleet-wide per-currency daily cap"). USDLOOP and LOOPUSD both
    // mirror into 'USD' (`loop_asset_mirror_currency`, migration 0061), so
    // they must draw on ONE shared USD daily-cap bucket. Pre-fix the cap
    // SUM was scoped by the bare `asset_code`, giving each code its OWN
    // 100M bucket — a rogue/compromised admin splits a day's emissions
    // across the two mirror-sharing codes to mint up to ~2x the intended
    // per-currency ceiling. Drive the primitive directly (the HTTP surface
    // adds a 10M per-request cap that would need many calls).
    const { targetUser } = await seed();
    // Mirror balance far above the day's emissions so neither the per-call
    // balance guard nor the conservation fence (both already scoped by
    // mirror currency) can fire first — isolating the DAILY CAP as the only
    // gate under test.
    await seedCashbackBalance({ userId: targetUser.id, amountMinor: 400_000_000n });

    const ISSUER = 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const intent = (
      assetCode: string,
      amountMinor: bigint,
    ): {
      assetCode: string;
      assetIssuer: string;
      toAddress: string;
      amountStroops: bigint;
      memoText: string;
    } => ({
      assetCode,
      assetIssuer: ISSUER,
      toAddress: DEST,
      amountStroops: amountMinor * 100_000n,
      memoText: `capscope ${assetCode} ${amountMinor}`,
    });

    // First emission: 95M minor under USDLOOP — a legitimate emission that
    // stays UNDER the 100M USD cap. Must still succeed (the fix must not
    // over-reject a within-cap emission). USD bucket now 95M.
    const first = await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 95_000_000n,
      intent: intent('USDLOOP', 95_000_000n),
    });
    expect(first.payoutId).toBeTruthy();

    // Second emission: 95M minor under LOOPUSD — a DIFFERENT asset code
    // that shares the SAME 'USD' mirror. Combined they would materialise
    // 190M minor of USD-mirror value in one day, just under 2x the 100M
    // cap. Individually each code is under 100M, so the pre-fix
    // per-asset_code SUM sees a fresh 0-used LOOPUSD bucket and WRONGLY
    // ALLOWS it. Post-fix the sum is scoped by mirror currency: USD used is
    // already 95M, +95M = 190M > 100M → the cap REJECTS it.
    let thrown: unknown = null;
    const second = await applyAdminEmission({
      userId: targetUser.id,
      currency: 'USD',
      amountMinor: 95_000_000n,
      intent: intent('LOOPUSD', 95_000_000n),
    }).catch((err: unknown) => {
      thrown = err;
      return null;
    });

    // The per-currency breach must be refused, not queued on the strength
    // of a separate raw-asset_code bucket.
    expect(second).toBeNull();
    expect(thrown).toBeInstanceOf(DailyAdjustmentLimitError);

    // Disease-proof: exactly ONE emission landed (the within-cap USDLOOP
    // one). On the pre-fix per-asset_code scope BOTH would land — 190M USD
    // minted under a 100M per-currency cap.
    const queued = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.userId, targetUser.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.assetCode).toBe('USDLOOP');
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
    mintStepUp: (scope: AdminStepUpScope) => string;
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
        // SEC-02-stepup: fresh single-use payout-retry token per call —
        // same-key replay / concurrent retries each present their own.
        'X-Admin-Step-Up': args.mintStepUp('payout-retry'),
      },
      body: JSON.stringify({ reason: args.reason }),
    });
  }

  it('replays the cached envelope on idempotency-key reuse — the reset runs exactly once', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
    const payoutId = await seedFailedLegacyWithdrawalPayout({
      userId: targetUser.id,
      amountStroops: 500n * 100_000n,
    });
    const key = idemKey();

    const first = await retryRequest({ payoutId, bearer, mintStepUp, key, reason: 'first click' });
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

    const second = await retryRequest({
      payoutId,
      bearer,
      mintStepUp,
      key,
      reason: 'second click',
    });
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
      retryRequest({ payoutId, bearer, mintStepUp, key, reason: 'race click a' }),
      retryRequest({ payoutId, bearer, mintStepUp, key, reason: 'race click b' }),
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
    const { bearer, mintStepUp } = await seed();
    const key = idemKey();
    const missingId = crypto.randomUUID();

    const miss = await retryRequest({
      payoutId: missingId,
      bearer,
      mintStepUp,
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
    mintStepUp: (scope: AdminStepUpScope) => string;
    key: string;
  }): Promise<Response> {
    return app.request(`http://localhost/api/admin/users/${args.targetUserId}/credit-adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.bearer}`,
        'idempotency-key': args.key,
        // SEC-02-stepup: fresh single-use credit-adjustment token per call.
        'X-Admin-Step-Up': args.mintStepUp('credit-adjustment'),
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
    const { adminUserId, targetUser, bearer, mintStepUp } = await seed();
    const key = idemKey();
    await seedSnapshot({
      adminUserId,
      key,
      targetUserId: targetUser.id,
      responseBody: '{this is not json',
    });

    const res = await postAdjustment({ targetUserId: targetUser.id, bearer, mintStepUp, key });
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
    const { adminUserId, targetUser, bearer, mintStepUp } = await seed();
    const key = idemKey();
    await seedSnapshot({ adminUserId, key, targetUserId: targetUser.id, responseBody: '{}' });

    const res = await postAdjustment({ targetUserId: targetUser.id, bearer, mintStepUp, key });
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
      const { targetUser, bearer, mintStepUp } = await seed();
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
            'X-Admin-Step-Up': mintStepUp('payout-compensation'),
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
      const { targetUser, bearer, mintStepUp } = await seed();
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
        // Uncommitted usage a lock-less reader cannot see. DAT-01-inv1
        // (migration 0066): a real compensation is a MATCHED write, so
        // this simulated holder moves the mirror balance WITH the ledger
        // credit (both in this held txn) — the cap-lock serialization is
        // what's under test, not the mirror, and a one-sided +500 credit
        // would trip the deferred mirror trigger at the holder's commit.
        await tx.insert(creditTransactions).values({
          userId: targetUser.id,
          type: 'adjustment',
          amountMinor: 500n,
          currency: 'USD',
          referenceType: 'payout',
          referenceId: crypto.randomUUID(),
          reason: 'simulated concurrent compensation holding the cap lock',
        });
        await tx
          .insert(userCredits)
          .values({ userId: targetUser.id, currency: 'USD', balanceMinor: 500n })
          .onConflictDoUpdate({
            target: [userCredits.userId, userCredits.currency],
            set: { balanceMinor: sql`${userCredits.balanceMinor} + 500` },
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
            'X-Admin-Step-Up': mintStepUp('payout-compensation'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
          'X-Admin-Step-Up': mintStepUp('home-currency'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
    const key = idemKey();
    // SEC-02-stepup: fresh single-use token per request (the replay is
    // proven at the idempotency layer, past a valid step-up each time).
    const headers = (): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'idempotency-key': key,
      'X-Admin-Step-Up': mintStepUp('home-currency'),
    });
    const url = `http://localhost/api/admin/users/${targetUser.id}/home-currency`;
    const body = JSON.stringify({ homeCurrency: 'GBP', reason: 'idempotent retry' });

    const first = await app.request(url, { method: 'POST', headers: headers(), body });
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

    const second = await app.request(url, { method: 'POST', headers: headers(), body });
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
    const { targetUser, bearer, mintStepUp } = await seed();
    const res = await app.request(
      `http://localhost/api/admin/users/${targetUser.id}/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': mintStepUp('home-currency'),
        },
        body: JSON.stringify({ homeCurrency: 'USD', reason: 'no-op' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_UNCHANGED');
  });

  it('409 HOME_CURRENCY_HAS_LIVE_BALANCE when user has non-zero credits in old currency', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
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
          'X-Admin-Step-Up': mintStepUp('home-currency'),
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
    const { targetUser, bearer, mintStepUp } = await seed();
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
          'X-Admin-Step-Up': mintStepUp('home-currency'),
        },
        body: JSON.stringify({ homeCurrency: 'EUR', reason: 'zero-balance ok' }),
      },
    );
    expect(res.status).toBe(200);
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('EUR');
  });

  it('409 HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS when user has a pending payout', async () => {
    const { targetUser, bearer, mintStepUp, orderId } = await seed();
    // MNY-01-INV3 (migration 0067): the in-flight guard has to fire while
    // the OLD-currency balance is ZERO (the live-balance preflight, checked
    // FIRST, would otherwise 409 with a different code). A `kind='burn'`
    // (pending redemption issuer-return) is the conservation-correct way to
    // model "zero balance + an in-flight payout": a burn is NOT a mint, so
    // the 0067 fence doesn't gate it, and a redeemed-to-zero user with a
    // still-pending issuer-return is a real reachable state. An in-flight
    // `order_cashback` with no mirror backing is exactly the unbacked mint
    // 0067 now forbids, so it can no longer stand in here.
    await db.insert(pendingPayouts).values({
      userId: targetUser.id,
      kind: 'burn',
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
          'X-Admin-Step-Up': mintStepUp('home-currency'),
        },
        body: JSON.stringify({ homeCurrency: 'GBP', reason: 'should fail' }),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS');
  });

  it('allows the change when user has only failed payouts (already off the worker hot path)', async () => {
    const { targetUser, bearer, mintStepUp } = await seed();
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
          'X-Admin-Step-Up': mintStepUp('home-currency'),
        },
        body: JSON.stringify({ homeCurrency: 'EUR', reason: 'failed payouts ok' }),
      },
    );
    expect(res.status).toBe(200);
    const after = await db.select().from(users).where(eq(users.id, targetUser.id));
    expect(after[0]?.homeCurrency).toBe('EUR');
  });

  it('404 USER_NOT_FOUND when target user does not exist', async () => {
    const { bearer, mintStepUp } = await seed();
    const res = await app.request(
      `http://localhost/api/admin/users/aaaaaaaa-bbbb-cccc-dddd-000000000000/home-currency`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'idempotency-key': idemKey(),
          'X-Admin-Step-Up': mintStepUp('home-currency'),
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

// SEC-clearotp: the per-target OTP-lockout-clear velocity cap
// (CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY, default 5) must hold under a
// CONCURRENT burst of requests with DISTINCT idempotency keys aimed at the
// SAME target. `withIdempotencyGuard` serialises only same-(admin, key)
// callers, so before the per-target advisory lock a distinct-key burst all
// read the same pre-commit prior-clear count and every one slipped past the
// cap. This exercises the real advisory-lock serialisation against postgres
// (the unit suite can only prove the handler HONOURS a lock result).
describeIf(
  'admin clear-otp-lockout — per-target cap holds under a concurrent distinct-key burst (SEC-clearotp)',
  () => {
    beforeAll(async () => {
      await ensureMigrated();
    });

    beforeEach(async () => {
      await truncateAllTables();
      __resetRateLimitsForTests();
    });

    it('with CAP-1 prior clears, two concurrent clears apply exactly ONE more — never bypassing the cap', async () => {
      const { admin, target, bearer } = await (async () => {
        const a = await upsertUserFromCtx({
          ctxUserId: 'test-admin-id',
          email: 'admin@test.local',
        });
        const { token } = signLoopToken({
          sub: a.id,
          email: a.email,
          typ: 'access',
          ttlSeconds: 300,
          // NS-09: stamp the seeded admin's current token_version (0).
          tv: a.tokenVersion,
        });
        const t = await findOrCreateUserByEmail('lockme@test.local');
        return { admin: a, target: t, bearer: token };
      })();

      const clearPath = `/api/admin/users/${target.id}/clear-otp-lockout`;

      // A real, live lockout so the winning clear reports wasLocked: true and
      // actually deletes the counter row.
      await db.insert(otpAttemptCounters).values({
        email: target.email,
        failedAttempts: 10,
        windowStartedAt: new Date(),
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      });

      // Seed CAP-1 already-APPLIED clears for THIS target (committed
      // admin_idempotency_keys rows on the clear path). The next applied clear
      // is the CAPth (allowed); a bypass would let a SECOND concurrent one
      // through as the (CAP+1)th.
      const priorToSeed = CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY - 1;
      for (let i = 0; i < priorToSeed; i++) {
        await db.insert(adminIdempotencyKeys).values({
          adminUserId: admin.id,
          key: `seeded-prior-clear-${i}-${idemKey()}`,
          method: 'POST',
          path: clearPath,
          status: 200,
          responseBody: '{}',
        });
      }

      const fire = (key: string): Promise<Response> =>
        Promise.resolve(
          app.request(`http://localhost${clearPath}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bearer}`,
              'idempotency-key': key,
            },
            body: JSON.stringify({ reason: 'concurrent clear burst — SEC-clearotp' }),
          }),
        );

      const [a, b] = await Promise.all([fire(`${idemKey()}-a`), fire(`${idemKey()}-b`)]);

      // Exactly one clear may land as the CAPth. The other is rejected — 409
      // (lost the per-target advisory lock) or 429 (acquired it but now sees
      // the cap already reached). Pre-fix: BOTH counted CAP-1 and returned 200.
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses[0]).toBe(200);
      expect([409, 429]).toContain(statuses[1]);

      // Ground truth: applied clears on this path must equal the cap, never
      // CAP+1. This is the assertion that fails red against the racy code.
      const [{ n: applied } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(adminIdempotencyKeys)
        .where(eq(adminIdempotencyKeys.path, clearPath));
      expect(applied).toBe(CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY);

      // The single winning clear actually cleared the counter (idempotent
      // delete), so the target is unlocked.
      const counterRows = await db
        .select()
        .from(otpAttemptCounters)
        .where(eq(otpAttemptCounters.email, target.email));
      expect(counterRows).toHaveLength(0);
    });
  },
);
