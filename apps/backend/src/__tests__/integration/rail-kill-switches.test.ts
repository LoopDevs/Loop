/**
 * NS-04 — runtime rail kill-switch enforcement + admin API (real postgres).
 *
 * Proves, against a real DB and the real Hono app, the behaviours a unit
 * test can't: a halt row actually rejects new work at each rail's entry
 * point (block-new-only), a resume re-enables it, and the admin API's
 * authz / step-up / idempotency / audit ladder.
 *
 * What's mocked: the external money edges only — `submitPayout` (Stellar
 * submit), Horizon reads (`listAccountPayments` / outbound lookups),
 * trustlines, price-feed, and the fire-and-forget Discord notifiers.
 * What's REAL: the `rail_kill_switches` table + `DbKillSwitchService`, the
 * worker ticks' halt guards, the refund/vault primitives' halt guards, and
 * the full admin request path (requireAuth + requireStaff + step-up +
 * idempotency guard).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

vi.mock('../../payments/payout-submit.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, submitPayout: vi.fn() };
});

vi.mock('../../payments/horizon.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listAccountPayments: vi.fn(async () => ({ records: [], nextCursor: null })),
    findOutboundPaymentByMemo: vi.fn(async () => null),
    getOutboundPaymentByTxHash: vi.fn(async () => null),
  };
});

class AlwaysTrustingMap extends Map<
  string,
  { code: string; issuer: string; balanceStroops: bigint; limitStroops: bigint }
> {
  override get(
    key: string,
  ): { code: string; issuer: string; balanceStroops: bigint; limitStroops: bigint } | undefined {
    const [code, issuer] = key.split('::');
    if (code === undefined || issuer === undefined) return undefined;
    return { code, issuer, balanceStroops: 0n, limitStroops: 1_000_000_000_000_000n };
  }
}
vi.mock('../../payments/horizon-trustlines.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getAccountTrustlines: vi.fn(async (account: string) => ({
      account,
      accountExists: true,
      trustlines: new AlwaysTrustingMap(),
      asOfMs: Date.now(),
    })),
  };
});

vi.mock('../../payments/price-feed.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getUsdToGbpRate: vi.fn(async () => 0.8) };
});

vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const noop = vi.fn();
  return {
    ...actual,
    notifyAdminAudit: noop,
    notifyPayoutFailed: noop,
    notifyPayoutAwaitingTrustline: noop,
    notifyAdminBulkRead: noop,
    notifyLoopAssetOverpayment: noop,
  };
});

import { db } from '../../db/client.js';
import { users, orders, pendingPayouts, railKillSwitches } from '../../db/schema.js';
import { findOrCreateUserByEmail, upsertUserFromCtx } from '../../db/users.js';
import { app } from '../../app.js';
import { signLoopToken } from '../../auth/tokens.js';
import { signAdminStepUpToken, type AdminStepUpScope } from '../../auth/admin-step-up.js';
import { DbKillSwitchService, RailHaltedError } from '../../rail-kill-switches/index.js';
import { runPayoutTick } from '../../payments/payout-worker.js';
import { runPaymentWatcherTick } from '../../payments/watcher.js';
import { listAccountPayments, findOutboundPaymentByMemo } from '../../payments/horizon.js';
import { submitPayout } from '../../payments/payout-submit.js';
import { applyAdminRefund } from '../../credits/refunds.js';
import { refundDeposit } from '../../payments/deposit-refund.js';
import { depositToVault } from '../../credits/vaults/vault-client.js';
import {
  ensureMigrated,
  truncateAllTables,
  seedUserCreditsWithBackingLedger,
} from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;
const svc = new DbKillSwitchService();

function idemKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('base64url');
}

/** Direct halt-row write (bypasses the audited API) for enforcement setup. */
async function haltRow(
  rail: 'deposit' | 'payout' | 'vault' | 'refund',
  actorUserId: string,
): Promise<void> {
  await db
    .insert(railKillSwitches)
    .values({ rail, halted: true, reason: 'test halt', actorUserId })
    .onConflictDoUpdate({
      target: railKillSwitches.rail,
      set: { halted: true, reason: 'test halt', actorUserId, updatedAt: new Date() },
    });
}

async function seedAdmin(): Promise<{
  id: string;
  email: string;
  bearer: string;
  mintStepUp: (s: AdminStepUpScope) => string;
}> {
  const admin = await upsertUserFromCtx({ ctxUserId: 'test-admin-id', email: 'admin@test.local' });
  const { token } = signLoopToken({
    sub: admin.id,
    email: admin.email,
    typ: 'access',
    ttlSeconds: 300,
    tv: admin.tokenVersion,
  });
  const mintStepUp = (scope: AdminStepUpScope): string =>
    signAdminStepUpToken({ sub: admin.id, email: admin.email, scope }).token;
  return { id: admin.id, email: admin.email, bearer: token, mintStepUp };
}

const DEFAULT_PAYOUT_ARGS = {
  operatorSecret: 'STESTSECRET',
  operatorAccount: 'GTESTOPERATOR',
  horizonUrl: 'https://horizon-test.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  maxAttempts: 5,
};

async function seedClaimablePayout(): Promise<string> {
  const user = await findOrCreateUserByEmail(`payout-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, user.id));
  await seedUserCreditsWithBackingLedger(db, {
    userId: user.id,
    currency: 'USD',
    balanceMinor: 500n,
  });
  const [row] = await db
    .insert(pendingPayouts)
    .values({
      userId: user.id,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      toAddress: 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountStroops: 50_000_000n,
      memoText: `payout-${Date.now()}`,
      state: 'pending',
      attempts: 0,
    })
    .returning({ id: pendingPayouts.id });
  if (row === undefined) throw new Error('seedClaimablePayout: no row');
  return row.id;
}

async function seedRefundableOrder(): Promise<{ userId: string; orderId: string }> {
  const target = await findOrCreateUserByEmail(`refund-${Date.now()}-${Math.random()}@test.local`);
  await db.update(users).set({ homeCurrency: 'USD' }).where(eq(users.id, target.id));
  const [orderRow] = await db
    .insert(orders)
    .values({
      userId: target.id,
      merchantId: 'amazon',
      faceValueMinor: 5000n,
      currency: 'USD',
      chargeMinor: 5000n,
      chargeCurrency: 'USD',
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 3500n,
      userCashbackMinor: 250n,
      loopMarginMinor: 1250n,
      state: 'fulfilled',
    })
    .returning({ id: orders.id });
  if (orderRow === undefined) throw new Error('seedRefundableOrder: no row');
  return { userId: target.id, orderId: orderRow.id };
}

describeIf('NS-04 — service round-trip + defaults (real DB)', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => truncateAllTables());

  it('a MISSING row reads as not halted (default), and listStates returns all four rails', async () => {
    expect(await svc.isHalted('payout')).toBe(false);
    const states = await svc.listStates();
    expect(states.map((s) => s.rail).sort()).toEqual(['deposit', 'payout', 'refund', 'vault']);
    expect(states.every((s) => s.halted === false)).toBe(true);
  });

  it('halt → isHalted true + getState carries reason/actor; resume → isHalted false', async () => {
    const admin = await seedAdmin();
    await svc.halt({
      rail: 'payout',
      actorUserId: admin.id,
      reason: 'incident',
      idempotencyKey: idemKey(),
    });
    expect(await svc.isHalted('payout')).toBe(true);
    const state = await svc.getState('payout');
    expect(state).toMatchObject({
      rail: 'payout',
      halted: true,
      reason: 'incident',
      actorUserId: admin.id,
    });
    // Only the halted rail is affected.
    expect(await svc.isHalted('deposit')).toBe(false);

    await svc.resume({
      rail: 'payout',
      actorUserId: admin.id,
      reason: 'all clear',
      idempotencyKey: idemKey(),
    });
    expect(await svc.isHalted('payout')).toBe(false);
  });
});

describeIf('NS-04 — payout rail enforcement (block-new-only)', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(submitPayout).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockReset();
    vi.mocked(findOutboundPaymentByMemo).mockResolvedValue(null);
  });

  it('halted → tick claims nothing and the queued row STAYS pending; resume → it drains', async () => {
    const admin = await seedAdmin();
    const payoutId = await seedClaimablePayout();

    await haltRow('payout', admin.id);
    const halted = await runPayoutTick(DEFAULT_PAYOUT_ARGS);
    expect(halted.picked).toBe(0);
    expect(halted.confirmed).toBe(0);
    expect(submitPayout).not.toHaveBeenCalled();
    // Block-new-only: the queued row is untouched, ready to re-drain.
    const [afterHalt] = await db
      .select()
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, payoutId));
    expect(afterHalt!.state).toBe('pending');

    // Resume → the same row is now claimed + submitted.
    await svc.resume({
      rail: 'payout',
      actorUserId: admin.id,
      reason: 'resume',
      idempotencyKey: idemKey(),
    });
    vi.mocked(submitPayout).mockResolvedValueOnce({ txHash: 'tx-hash-1', ledger: 123 });
    const resumed = await runPayoutTick(DEFAULT_PAYOUT_ARGS);
    expect(resumed.picked).toBe(1);
    expect(submitPayout).toHaveBeenCalledTimes(1);
  });
});

describeIf('NS-04 — deposit rail enforcement (block-new-only, before Horizon)', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(listAccountPayments).mockClear();
    vi.mocked(listAccountPayments).mockResolvedValue({ records: [], nextCursor: null });
  });

  it('halted → tick early-returns and NEVER reads Horizon; resume → Horizon IS read', async () => {
    const admin = await seedAdmin();
    await haltRow('deposit', admin.id);

    const halted = await runPaymentWatcherTick({ account: 'GTESTDEPOSITACCOUNT' });
    expect(halted.scanned).toBe(0);
    expect(halted.matched).toBe(0);
    expect(listAccountPayments).not.toHaveBeenCalled();

    await svc.resume({
      rail: 'deposit',
      actorUserId: admin.id,
      reason: 'resume',
      idempotencyKey: idemKey(),
    });
    await runPaymentWatcherTick({ account: 'GTESTDEPOSITACCOUNT' });
    expect(listAccountPayments).toHaveBeenCalled();
  });
});

describeIf('NS-04 — refund rail enforcement (both primitives)', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => truncateAllTables());

  it('applyAdminRefund throws RailHaltedError when halted; succeeds after resume', async () => {
    const admin = await seedAdmin();
    const { userId, orderId } = await seedRefundableOrder();

    await haltRow('refund', admin.id);
    await expect(
      applyAdminRefund({
        userId,
        currency: 'USD',
        amountMinor: 1000n,
        orderId,
        adminUserId: admin.id,
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(RailHaltedError);

    await svc.resume({
      rail: 'refund',
      actorUserId: admin.id,
      reason: 'resume',
      idempotencyKey: idemKey(),
    });
    const refund = await applyAdminRefund({
      userId,
      currency: 'USD',
      amountMinor: 1000n,
      orderId,
      adminUserId: admin.id,
      reason: 'test',
    });
    expect(refund.amountMinor).toBe(1000n);
  });

  it('refundDeposit throws RailHaltedError when halted (before touching Horizon/DB)', async () => {
    const admin = await seedAdmin();
    await haltRow('refund', admin.id);
    await expect(refundDeposit('any-payment-id')).rejects.toBeInstanceOf(RailHaltedError);
  });
});

describeIf('NS-04 — vault rail enforcement', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => truncateAllTables());

  it('depositToVault throws RailHaltedError when halted; passes the gate when not halted', async () => {
    const admin = await seedAdmin();
    // The halt gate fires before any arg is used, so a minimal dummy is
    // enough — cast through `unknown` to the arg type without `any`.
    const dummyArgs = { vault: {}, underlyingAmount: 0n, minShares: 0n } as unknown as Parameters<
      typeof depositToVault
    >[0];

    await haltRow('vault', admin.id);
    await expect(depositToVault(dummyArgs)).rejects.toBeInstanceOf(RailHaltedError);

    // Not halted: the halt gate is passed, so the NEXT guard fires instead
    // (a zero amount is refused by assertPositiveBigint) — proving the
    // rail check sits exactly at the mutating chokepoint, not blocking reads.
    await svc.resume({
      rail: 'vault',
      actorUserId: admin.id,
      reason: 'resume',
      idempotencyKey: idemKey(),
    });
    await expect(depositToVault(dummyArgs)).rejects.not.toBeInstanceOf(RailHaltedError);
  });
});

describeIf('NS-04 — admin API (authz + step-up + idempotency + audit)', () => {
  beforeAll(async () => ensureMigrated());
  beforeEach(async () => truncateAllTables());

  const LIST_URL = 'http://localhost/api/admin/rails/kill-switches';
  const haltUrl = (rail: string): string => `http://localhost/api/admin/rails/${rail}/halt`;
  const resumeUrl = (rail: string): string => `http://localhost/api/admin/rails/${rail}/resume`;

  it('unauthenticated → 401', async () => {
    const res = await app.request(LIST_URL);
    expect(res.status).toBe(401);
  });

  it('non-admin (plain user) → 404 (concealment)', async () => {
    const user = await findOrCreateUserByEmail('plain@test.local');
    const { token } = signLoopToken({
      sub: user.id,
      email: user.email,
      typ: 'access',
      ttlSeconds: 300,
      tv: user.tokenVersion,
    });
    const res = await app.request(LIST_URL, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it('halt: missing step-up → 401; wrong-scope step-up → 401', async () => {
    const admin = await seedAdmin();
    const headers = (extra: Record<string, string>): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${admin.bearer}`,
      'idempotency-key': idemKey(),
      ...extra,
    });
    const body = JSON.stringify({ reason: 'incident' });

    const noStepUp = await app.request(haltUrl('payout'), {
      method: 'POST',
      headers: headers({}),
      body,
    });
    expect(noStepUp.status).toBe(401);
    expect(((await noStepUp.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');

    // A token minted for a DIFFERENT class must not satisfy the rail-halt gate.
    const wrongScope = await app.request(haltUrl('payout'), {
      method: 'POST',
      headers: headers({ 'X-Admin-Step-Up': admin.mintStepUp('refund') }),
      body,
    });
    expect(wrongScope.status).toBe(401);
  });

  it('halt happy path → 200 envelope, list reflects halted, idempotent replay, resume clears', async () => {
    const admin = await seedAdmin();

    // Halt.
    const haltRes = await app.request(haltUrl('payout'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': admin.mintStepUp('rail-halt'),
      },
      body: JSON.stringify({ reason: 'incident-123' }),
    });
    expect(haltRes.status).toBe(200);
    const haltBody = (await haltRes.json()) as {
      result: { rail: string; halted: boolean };
      audit: { replayed: boolean };
    };
    expect(haltBody.result).toMatchObject({ rail: 'payout', halted: true });
    expect(haltBody.audit.replayed).toBe(false);

    // Enforcement sees it immediately.
    expect(await svc.isHalted('payout')).toBe(true);

    // List reflects it (admin read).
    const listRes = await app.request(LIST_URL, {
      headers: { Authorization: `Bearer ${admin.bearer}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { rails: Array<{ rail: string; halted: boolean }> };
    expect(listBody.rails.find((r) => r.rail === 'payout')?.halted).toBe(true);

    // Idempotent replay — SAME key returns the stored snapshot with replayed:true.
    const key = idemKey();
    const stepUpToken = admin.mintStepUp('rail-halt');
    const commonHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${admin.bearer}`,
      'idempotency-key': key,
      'X-Admin-Step-Up': stepUpToken,
    };
    const first = await app.request(haltUrl('refund'), {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ reason: 'dup' }),
    });
    expect(first.status).toBe(200);
    // The step-up token is single-use, so the replay needs a fresh one;
    // the idempotency guard replays the stored snapshot regardless.
    const second = await app.request(haltUrl('refund'), {
      method: 'POST',
      headers: { ...commonHeaders, 'X-Admin-Step-Up': admin.mintStepUp('rail-halt') },
      body: JSON.stringify({ reason: 'dup' }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { audit: { replayed: boolean } };
    expect(secondBody.audit.replayed).toBe(true);

    // Resume clears it.
    const resumeRes = await app.request(resumeUrl('payout'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': admin.mintStepUp('rail-resume'),
      },
      body: JSON.stringify({ reason: 'all-clear' }),
    });
    expect(resumeRes.status).toBe(200);
    expect(await svc.isHalted('payout')).toBe(false);
  });

  it('end-to-end: an HTTP halt makes the payout worker tick early-return', async () => {
    const admin = await seedAdmin();
    await seedClaimablePayout();

    await app.request(haltUrl('payout'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin.bearer}`,
        'idempotency-key': idemKey(),
        'X-Admin-Step-Up': admin.mintStepUp('rail-halt'),
      },
      body: JSON.stringify({ reason: 'freeze payouts' }),
    });

    const tick = await runPayoutTick(DEFAULT_PAYOUT_ARGS);
    expect(tick.picked).toBe(0);
  });
});
