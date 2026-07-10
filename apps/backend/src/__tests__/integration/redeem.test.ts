/**
 * Wallet-spend (`orders/redeem.ts`, ADR 030 Phase C3 / ADR 036)
 * integration test on real postgres (Q6-6).
 *
 * `orders/__tests__/redeem.test.ts` (the unit suite) mocks
 * `db/client.js`'s `withAdvisoryLock` entirely with an in-memory Map
 * (see that file's `advisoryLockState`), so it can pin the handler's
 * CALL SHAPE — exactly one submit under a simulated lock race — but
 * cannot prove that a REAL Postgres session-scoped advisory lock
 * (`pg_try_advisory_lock` on a `client.reserve()`-pinned connection,
 * `db/client.ts`) actually excludes a second, genuinely concurrent
 * redemption attempt.
 *
 * The handler has TWO fences (see `orders/redeem.ts`'s own doc
 * comment): an in-process `Set` (same-machine double-tap) and the
 * fleet-wide advisory lock (cross-machine). Two same-process HTTP
 * calls always resolve the in-process Set first — deterministically,
 * since the check-then-add is synchronous with no `await` in between
 * — so they never independently exercise the advisory lock. This
 * test clears the in-process Set between the two calls (via the
 * exported `__resetRedeemFenceForTests` test seam) to simulate "a
 * second machine, whose in-process Set doesn't know about this
 * order" — the exact scenario the advisory lock exists for — and
 * proves the REAL lock alone still excludes the second attempt.
 *
 * What's mocked: Horizon (`getAccountTrustlines` + `Horizon.Server`)
 * and the wallet-provider signing bridge + `submitPreSignedTransaction`
 * — the same external boundaries the unit suite mocks. What's REAL:
 * postgres (the order/user rows, the advisory lock), Hono routing,
 * and the Loop-signed auth path.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Keypair, type Account as StellarAccount } from '@stellar/stellar-sdk';
import type * as StellarSdkModule from '@stellar/stellar-sdk';
import type * as HorizonTrustlinesModule from '../../payments/horizon-trustlines.js';
import type * as WalletProviderModule from '../../wallet/provider.js';
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Real ed25519 keypair for the "embedded wallet" -- rawSign below
// signs with it for real, so the fee-bump envelope the mocked
// `submitPreSignedTransaction` receives carries an actually-
// verifiable user signature, same testing philosophy as the unit
// suite (never hardcode a Stellar secret literal -- generated fresh
// per process, `scripts/lint-docs.sh` §5b).
const userKeypair = Keypair.random();

// Controls when the FIRST call's Horizon trustline read (the first
// await inside the advisory-lock-guarded section) resolves, so the
// test can hold the real lock open while orchestrating the second,
// concurrent call.
let pauseGate: Promise<void> = Promise.resolve();
let trustlinesCallCount = 0;

vi.mock('../../payments/horizon-trustlines.js', async (importActual) => {
  const actual = await importActual<typeof HorizonTrustlinesModule>();
  return {
    ...actual,
    getAccountTrustlines: vi.fn(async (account: string) => {
      trustlinesCallCount++;
      await pauseGate;
      return {
        account,
        accountExists: true,
        trustlines: new Map([
          [
            `GBPLOOP::${process.env['LOOP_STELLAR_GBPLOOP_ISSUER']}`,
            {
              code: 'GBPLOOP',
              issuer: process.env['LOOP_STELLAR_GBPLOOP_ISSUER']!,
              balanceStroops: 100_000_000_000n, // 10,000 GBPLOOP -- comfortably funded
              limitStroops: 10n ** 15n,
            },
          ],
        ]),
        asOfMs: Date.now(),
      };
    }),
  };
});

vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof StellarSdkModule>();
  class FakeServer {
    async loadAccount(accountId: string): Promise<StellarAccount> {
      return new actual.Account(accountId, '99');
    }
  }
  return { ...actual, Horizon: { ...actual.Horizon, Server: FakeServer } };
});

vi.mock('../../wallet/provider.js', async (importActual) => {
  const actual = await importActual<typeof WalletProviderModule>();
  return {
    ...actual,
    getWalletProvider: () => ({
      name: 'privy' as const,
      createWallet: vi.fn(),
      rawSign: async (_walletId: string, hashHex: string) =>
        userKeypair.sign(Buffer.from(hashHex, 'hex')).toString('hex'),
    }),
  };
});

const { submitMock } = vi.hoisted(() => ({
  submitMock: vi.fn(async (_args: unknown) => ({ txHash: 'redeem-int-tx', ledger: 1 })),
}));
vi.mock('../../payments/payout-submit.js', async (importActual) => {
  const actual = await importActual<typeof PayoutSubmitModule>();
  return { ...actual, submitPreSignedTransaction: submitMock };
});

import { db } from '../../db/client.js';
import { app, __resetRateLimitsForTests } from '../../app.js';
import { users, orders } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { signLoopToken } from '../../auth/tokens.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import { __resetRedeemFenceForTests } from '../../orders/redeem.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const MEMO = 'ABCDEFGHIJKLMNOPQRST';

async function seedRedeemableOrder(): Promise<{ orderId: string; userId: string }> {
  const email = `redeem-int-${crypto.randomUUID()}@test.local`;
  const user = await findOrCreateUserByEmail(email);
  await db
    .update(users)
    .set({
      walletProvider: 'privy',
      walletId: `wallet-${crypto.randomUUID()}`,
      walletAddress: userKeypair.publicKey(),
      walletProvisioning: 'activated',
    })
    .where(eq(users.id, user.id));

  const [orderRow] = await db
    .insert(orders)
    .values({
      userId: user.id,
      merchantId: 'amazon',
      faceValueMinor: 250n,
      currency: 'GBP',
      chargeMinor: 250n,
      chargeCurrency: 'GBP',
      paymentMethod: 'loop_asset',
      paymentMemo: MEMO,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 175n,
      userCashbackMinor: 12n,
      loopMarginMinor: 63n,
      state: 'pending_payment',
    })
    .returning();
  if (orderRow === undefined) throw new Error('seed: order insert returned no row');
  return { orderId: orderRow.id, userId: user.id };
}

function bearerFor(userId: string, email: string): string {
  return signLoopToken({ sub: userId, email, typ: 'access', ttlSeconds: 300 }).token;
}

describeIf('wallet-spend (redeem) integration — real postgres advisory lock (Q6-6)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetRateLimitsForTests();
    __resetRedeemFenceForTests();
    pauseGate = Promise.resolve();
    trustlinesCallCount = 0;
    submitMock.mockClear();
  });

  afterEach(async () => {
    expect(await computeLedgerDriftSql(db)).toEqual([]);
  });

  it('a genuinely concurrent second redemption attempt is excluded by the REAL Postgres advisory lock (not just the in-process fence)', async () => {
    const { orderId, userId } = await seedRedeemableOrder();
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user === undefined || user === null) throw new Error('seed user missing');
    const bearer = bearerFor(userId, user.email);

    // Release the gate only once WE choose to -- call 1 will block on
    // its first Horizon read, which happens strictly after the real
    // `pg_try_advisory_lock` has already succeeded (db/client.ts:
    // the lock acquisition + the reserved connection both resolve
    // before `fn()` -- the code containing the Horizon call -- runs).
    let releaseCall1: () => void = () => {};
    pauseGate = new Promise<void>((resolve) => {
      releaseCall1 = resolve;
    });

    const call1 = app.request(`http://localhost/api/orders/loop/${orderId}/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });

    // Wait until call 1 has genuinely entered the locked section
    // (proven by its Horizon read firing) before simulating "a
    // second machine" by clearing the in-process fence.
    await vi.waitFor(
      () => {
        if (trustlinesCallCount < 1) throw new Error('call 1 has not reached Horizon yet');
      },
      { timeout: 2000, interval: 5 },
    );
    __resetRedeemFenceForTests();

    const call2Response = await app.request(`http://localhost/api/orders/loop/${orderId}/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const call2Body = (await call2Response.json()) as { code?: string };

    // The real advisory lock excluded call 2 -- it never reached
    // Horizon (still exactly 1 call, from call 1).
    expect(call2Response.status).toBe(400);
    expect(call2Body.code).toBe('PAYMENT_IN_FLIGHT');
    expect(trustlinesCallCount).toBe(1);
    expect(submitMock).not.toHaveBeenCalled();

    releaseCall1();
    const call1Response = await call1;
    const call1Body = (await call1Response.json()) as { state?: string };

    expect(call1Response.status).toBe(200);
    expect(call1Body.state).toBeDefined();
    // Exactly one submission reached Stellar despite two concurrent
    // HTTP attempts -- the money-safety property INV-9-adjacent
    // (one outbound payment per redemption) this whole fence exists
    // to guarantee.
    expect(submitMock).toHaveBeenCalledTimes(1);

    const finalOrder = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    expect(finalOrder?.state).toBe('pending_payment'); // watcher hasn't run in this suite
  });

  it('sanity: with the fence uncontended, a solo redemption submits exactly once', async () => {
    const { orderId, userId } = await seedRedeemableOrder();
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (user === undefined || user === null) throw new Error('seed user missing');
    const bearer = bearerFor(userId, user.email);

    const res = await app.request(`http://localhost/api/orders/loop/${orderId}/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    });

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(trustlinesCallCount).toBe(1);
  });
});
