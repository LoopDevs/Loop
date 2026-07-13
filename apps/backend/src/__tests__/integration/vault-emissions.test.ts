/**
 * ADR 031 §D5 (V3) — vault cashback-emission state machine, real
 * postgres (mirrors `__tests__/integration/interest-mint.test.ts`'s
 * shape for the same class of reason).
 *
 * What ONLY a real DB can prove (the unit suite,
 * `credits/vaults/__tests__/vault-emissions.test.ts`, mocks the whole
 * `db/client.js`):
 *
 *   1. `vault_emissions_order_unique` actually fires as a real 23505
 *      on a genuine duplicate claim, not a hand-built fake.
 *   2. The REAL `assert_emission_conservation` trigger (migration
 *      0044, widened by migration 0061) actually rejects an
 *      over-limit `pending_payouts kind='emission'` insert for
 *      LOOPUSD/LOOPEUR — the whole point of routing the mirror
 *      step's audit row through it.
 *   3. The migration-0061 CROSS-ASSET fix: a user with BOTH a classic
 *      USDLOOP emission AND a LOOPUSD emission sharing the same USD
 *      mirror balance is bounded by their COMBINED value, not
 *      independently per asset code (the bug the trigger's `WHERE
 *      pp.asset_code = NEW.asset_code` → mirror-currency-scoped
 *      rewrite closes).
 *   4. The ledger-invariant `afterEach` assertion (hardening C7) —
 *      the vault mirror step never desyncs `user_credits` from
 *      `credit_transactions`.
 *
 * Only `credits/vaults/vault-client.js` (the Soroban wire layer) is
 * mocked — no network. `credits/vaults/registry.js` reads the REAL
 * `loop_vaults` row this suite inserts. Everything else (`db`,
 * `vault_emissions`, `credit_transactions`, `user_credits`,
 * `pending_payouts`, the trigger) is real postgres.
 *
 * Gated on `LOOP_E2E_DB=1` like the sibling integration suites.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Keypair, Address } from '@stellar/stellar-sdk';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Real strkey-shaped fixtures (56 chars, correct checksum) — the
// table's own CHECK constraints (`pending_payouts_asset_issuer_format`
// / `_to_address_format`) validate the shape, so a hand-typed
// placeholder of the wrong length fails the INSERT before the trigger
// this suite is testing even runs.
const OPERATOR_PUBLIC = Keypair.random().publicKey();
const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();
const VAULT_CONTRACT_ID = Address.contract(Buffer.alloc(32, 3)).toString();
const USDLOOP_ISSUER = Keypair.random().publicKey();

// Only the Soroban wire layer is mocked (matches the V2 unit suite's
// own posture) — deposit/transfer results are test-controlled.
const { vaultClientState, vaultClientMocks } = vi.hoisted(() => ({
  vaultClientState: {
    depositResult: null as null | { txHash: string; sharesMinted: bigint },
    transferResult: null as null | { txHash: string },
  },
  vaultClientMocks: {
    depositToVault: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      const r = vaultClientState.depositResult ?? {
        txHash: 'default-deposit-tx',
        sharesMinted: 100n,
      };
      await args.onSigned(r.txHash);
      return { txHash: r.txHash, sharesMinted: r.sharesMinted, amountsUsed: [], deduped: false };
    }),
    transferShares: vi.fn(async (args: { onSigned: (h: string) => Promise<void> | void }) => {
      const r = vaultClientState.transferResult ?? { txHash: 'default-transfer-tx' };
      await args.onSigned(r.txHash);
      return { txHash: r.txHash, deduped: false };
    }),
    readVaultState: vi.fn(async () => ({
      totalSupply: 1_000_000_000n,
      totalManaged: 1_000_000_000n,
      sharePricePpm: 1_000_000n,
    })),
    resolveOperatorPublicKey: vi.fn(() => OPERATOR_PUBLIC),
  },
}));
vi.mock('../../credits/vaults/vault-client.js', () => ({
  depositToVault: (...args: Parameters<typeof vaultClientMocks.depositToVault>) =>
    vaultClientMocks.depositToVault(...args),
  transferShares: (...args: Parameters<typeof vaultClientMocks.transferShares>) =>
    vaultClientMocks.transferShares(...args),
  readVaultState: (...args: Parameters<typeof vaultClientMocks.readVaultState>) =>
    vaultClientMocks.readVaultState(...args),
  resolveOperatorPublicKey: () => vaultClientMocks.resolveOperatorPublicKey(),
}));

// The stuck-emission watchdog pages via `notifyVaultEmissionsStuck`
// (→ `sendWebhook(env.DISCORD_WEBHOOK_MONITORING)`). No webhook is set
// in the integration env, and post-FT-06 an UNSET webhook reports
// NON-delivery (`false`) — it no longer phantom-reports success — so
// the watchdog would never latch its fire-once `alert_active`. Stub the
// delivery-tracked notifier to report a successful delivery (matching
// how the sibling watcher suite `asset-drift-watcher.test.ts` mocks its
// own notifiers) so NO real Discord call happens and `notified===true`
// genuinely asserts the "delivered once, then don't re-page" behaviour
// rather than the old phantom-true. Every other `../../discord.js`
// export (e.g. `notifyVaultEmissionFailed`) stays real via `...actual`.
vi.mock('../../discord.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    notifyVaultEmissionsStuck: vi.fn(async () => true),
  };
});

import { db, withAdvisoryLock } from '../../db/client.js';
import {
  users,
  orders,
  loopVaults,
  vaultEmissions,
  pendingPayouts,
  userCredits,
  creditTransactions,
  watchdogAlertState,
} from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { computeLedgerDriftSql } from '../../credits/ledger-invariant.js';
import { generatePayoutMemo } from '../../credits/payout-builder.js';
import {
  claimVaultEmission,
  driveOneVaultEmission,
  runVaultEmissionStuckWatchdog,
  vaultEmissionSweepLockKey,
  type VaultEmissionRow,
} from '../../credits/vaults/vault-emissions.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function seedUser(): Promise<{ id: string; walletAddress: string }> {
  const email = `vault-emission-${crypto.randomUUID()}@test.local`;
  const user = await findOrCreateUserByEmail(email);
  const walletAddress = Keypair.random().publicKey();
  await db
    .update(users)
    .set({
      homeCurrency: 'USD',
      walletProvider: 'privy',
      walletId: `wallet-${crypto.randomUUID()}`,
      walletAddress,
      walletProvisioning: 'activated',
    })
    .where(eq(users.id, user.id));
  return { id: user.id, walletAddress };
}

async function seedOrder(args: { userId: string; cashbackMinor: bigint }): Promise<string> {
  const merchantId = crypto.randomUUID();
  const [order] = await db
    .insert(orders)
    .values({
      userId: args.userId,
      merchantId,
      faceValueMinor: 5000n,
      currency: 'USD',
      chargeMinor: 5000n,
      chargeCurrency: 'USD',
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 3500n,
      userCashbackMinor: args.cashbackMinor,
      loopMarginMinor: 1250n,
      state: 'fulfilled',
    })
    .returning({ id: orders.id });
  return order!.id;
}

/**
 * Seeds a `user_credits` balance WITH its backing `credit_transactions`
 * row (type='adjustment' — outside `credit_transactions_reference_unique`'s
 * scope, so no reference collision risk) so the shared `afterEach`
 * ledger-drift assertion stays green. The trigger-arithmetic tests
 * below seed a balance directly to control the exact headroom the
 * trigger checks against; without a matching ledger row that balance
 * would itself be an (unrelated, test-only) drift.
 */
async function seedUserCreditsBalance(
  userId: string,
  currency: string,
  amountMinor: bigint,
): Promise<void> {
  await db.insert(userCredits).values({ userId, currency, balanceMinor: amountMinor });
  await db.insert(creditTransactions).values({
    userId,
    type: 'adjustment',
    amountMinor,
    currency,
    referenceType: null,
    referenceId: null,
    reason: 'integration-test fixture balance',
  });
}

async function seedVault(): Promise<void> {
  await db.insert(loopVaults).values({
    assetCode: 'LOOPUSD',
    vaultContractId: VAULT_CONTRACT_ID,
    shareAssetCode: 'LOOPUSD',
    shareAssetIssuer: SHARE_CONTRACT_ID,
    underlyingAssetCode: 'USDC',
    underlyingAssetIssuer: 'GUSDCISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    strategyId: 'blend-usdc-pool',
    network: 'testnet',
    feeBps: 5000,
    active: true,
  });
}

describeIf('vault-emissions integration — real postgres (ADR 031 V3)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vaultClientState.depositResult = null;
    vaultClientState.transferResult = null;
    vaultClientMocks.depositToVault.mockClear();
    vaultClientMocks.transferShares.mockClear();
    await seedVault();
  });

  // Hardening C7 (mirrors flywheel.test.ts / interest-mint.test.ts):
  // the vault mirror step must never desync user_credits from
  // credit_transactions.
  afterEach(async () => {
    const drift = await computeLedgerDriftSql(db);
    expect(drift).toEqual([]);
  });

  it('claim -> deposit -> transfer -> mirror lands correctly against real postgres', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 500n });
    vaultClientState.depositResult = { txHash: 'dep-1', sharesMinted: 480n };
    vaultClientState.transferResult = { txHash: 'xfer-1' };

    const claimed = await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: user.walletAddress,
    });
    expect(claimed).toBe(true);

    const [row] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.orderId, orderId));
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);
    expect(outcome).toBe('mirrored');

    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(500n);

    const cashbackRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.type, 'cashback'),
          eq(creditTransactions.referenceId, orderId),
        ),
      );
    expect(cashbackRows).toHaveLength(1);

    const auditRows = await db
      .select()
      .from(pendingPayouts)
      .where(and(eq(pendingPayouts.userId, user.id), eq(pendingPayouts.kind, 'emission')));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      state: 'confirmed',
      txHash: 'xfer-1',
    });
  });

  it('vault_emissions_order_unique rejects a real duplicate claim for the same order', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 500n });

    const first = await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: user.walletAddress,
    });
    const second = await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: user.walletAddress,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await db.select().from(vaultEmissions).where(eq(vaultEmissions.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('the REAL assert_emission_conservation trigger rejects an over-limit LOOPUSD emission audit row', async () => {
    const user = await seedUser();
    // Mirror balance = 100 minor. A pending_payouts kind='emission'
    // insert requesting MORE than that (in the SAME dollar-pegged
    // amount_stroops convention the mirror step writes) must be
    // rejected by the trigger widened in migration 0061 — proving the
    // widening actually enforces INV-V1, not merely satisfies
    // check-money-invariants.mjs's static substring check.
    await seedUserCreditsBalance(user.id, 'USD', 100n);

    await expect(
      db.insert(pendingPayouts).values({
        userId: user.id,
        orderId: null,
        kind: 'emission',
        assetCode: 'LOOPUSD',
        assetIssuer: SHARE_CONTRACT_ID,
        toAddress: OPERATOR_PUBLIC,
        amountStroops: 200n * 100_000n, // 200 minor — exceeds the 100 minor balance
        memoText: generatePayoutMemo(),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      // Postgres RAISE EXCEPTION ... USING ERRCODE = 'check_violation' -> SQLSTATE 23514.
      const cause = (err as { cause?: { code?: string } }).cause;
      return cause?.code === '23514' || String(err).includes('emission_conservation');
    });

    // An emission within the un-emitted headroom succeeds.
    await db.insert(pendingPayouts).values({
      userId: user.id,
      orderId: null,
      kind: 'emission',
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      toAddress: OPERATOR_PUBLIC,
      amountStroops: 60n * 100_000n,
      memoText: generatePayoutMemo(),
    });
  });

  it('migration-0061 cross-asset fix: a prior classic USDLOOP emission is counted against a LOOPUSD emission sharing the same USD mirror', async () => {
    const user = await seedUser();
    await seedUserCreditsBalance(user.id, 'USD', 100n);

    // 70 minor already emitted via the CLASSIC USDLOOP asset code.
    await db.insert(pendingPayouts).values({
      userId: user.id,
      orderId: null,
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: USDLOOP_ISSUER,
      toAddress: OPERATOR_PUBLIC,
      amountStroops: 70n * 100_000n,
      memoText: generatePayoutMemo(),
    });

    // A further 50 minor via LOOPUSD would bring the COMBINED total
    // to 120 minor against a 100 minor mirror balance — must be
    // rejected. Pre-migration-0061 behaviour (asset_code-scoped
    // aggregation) would have WRONGLY allowed this (LOOPUSD alone
    // reads as 0 prior minted).
    await expect(
      db.insert(pendingPayouts).values({
        userId: user.id,
        orderId: null,
        kind: 'emission',
        assetCode: 'LOOPUSD',
        assetIssuer: SHARE_CONTRACT_ID,
        toAddress: OPERATOR_PUBLIC,
        amountStroops: 50n * 100_000n,
        memoText: generatePayoutMemo(),
      }),
    ).rejects.toBeTruthy();

    // 20 minor more (70 + 20 = 90 <= 100) is within the shared
    // headroom and must succeed.
    await db.insert(pendingPayouts).values({
      userId: user.id,
      orderId: null,
      kind: 'emission',
      assetCode: 'LOOPUSD',
      assetIssuer: SHARE_CONTRACT_ID,
      toAddress: OPERATOR_PUBLIC,
      amountStroops: 20n * 100_000n,
      memoText: generatePayoutMemo(),
    });
  });

  it('a row resumed from "deposited" does not re-deposit, and lands mirrored (real postgres state transitions)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 300n });
    await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 300n,
      toAddress: user.walletAddress,
    });
    const [claimed] = await db
      .select()
      .from(vaultEmissions)
      .where(eq(vaultEmissions.orderId, orderId));

    // Simulate a crash AFTER deposit landed — advance the row to
    // 'deposited' directly (what depositStep itself would have
    // persisted).
    await db
      .update(vaultEmissions)
      .set({
        state: 'deposited',
        depositTxHash: 'dep-prior',
        sharesMinted: 290n,
        depositedAt: new Date(),
      })
      .where(eq(vaultEmissions.id, claimed!.id));
    const [row] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.id, claimed!.id));

    vaultClientState.transferResult = { txHash: 'xfer-resumed' };
    const outcome = await driveOneVaultEmission(row as unknown as VaultEmissionRow);

    expect(outcome).toBe('mirrored');
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();
    expect(vaultClientMocks.transferShares).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 290n }),
    );
  });

  it('two concurrent drives over one pending row: exactly one deposits (real CAS, P1)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 500n });
    await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: user.walletAddress,
    });
    const [row] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.orderId, orderId));

    vaultClientState.depositResult = { txHash: 'dep-race', sharesMinted: 480n };
    vaultClientState.transferResult = { txHash: 'xfer-race' };

    // Race the SAME `pending` row from two "machines" — the real
    // `pending → depositing` state-CAS in postgres must let exactly
    // ONE win the deposit; the loser returns `claimed_elsewhere`.
    const [a, b] = await Promise.all([
      driveOneVaultEmission(row as unknown as VaultEmissionRow),
      driveOneVaultEmission(row as unknown as VaultEmissionRow),
    ]);

    const outcomes = [a, b].sort();
    expect(outcomes).toContain('claimed_elsewhere');
    // The winner drove all the way to mirrored.
    expect(outcomes).toContain('mirrored');
    // Deposit happened exactly once — no double-deposit / fund leak.
    expect(vaultClientMocks.depositToVault).toHaveBeenCalledTimes(1);

    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(500n);
  });

  it('the stuck-emission watchdog pages once per incident and re-arms when cleared (P1-2b, real advisory lock + watchdog_alert_state)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 400n });
    await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 400n,
      toAddress: user.walletAddress,
    });
    // Make it a STUCK in-flight row: state='deposited', created 30 min
    // ago (older than the 15-min threshold below). Delivery is stubbed
    // to SUCCEED (`notifyVaultEmissionsStuck` → true, mocked at the top
    // of this file) so the watchdog's fire-once latch actually engages —
    // this exercises the real "a page WAS delivered, now don't re-page"
    // semantics. Post-FT-06 an unset webhook makes sendWebhook resolve
    // `false` (non-delivery), so relying on an unset webhook here (the
    // old phantom-true contract) would latch nothing and test nothing.
    await db
      .update(vaultEmissions)
      .set({
        state: 'deposited',
        depositTxHash: 'dep-stuck',
        sharesMinted: 380n,
        depositedAt: new Date(),
        createdAt: new Date(Date.now() - 30 * 60_000),
      })
      .where(eq(vaultEmissions.orderId, orderId));

    // First run: pages + persists alert_active=true.
    const first = await runVaultEmissionStuckWatchdog({ thresholdMinutes: 15 });
    expect(first.notified).toBe(true);
    const [alert1] = await db
      .select()
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, 'vault-emission-stuck-watchdog'));
    expect(alert1?.alertActive).toBe(true);

    // Second run while the incident persists: no duplicate page.
    const second = await runVaultEmissionStuckWatchdog({ thresholdMinutes: 15 });
    expect(second.notified).toBe(false);

    // Clear the incident (row advances out of the stuck set) → re-arm.
    await db
      .update(vaultEmissions)
      .set({
        state: 'mirrored',
        transferTxHash: 'xfer-stuck',
        mirroredAt: new Date(),
      })
      .where(eq(vaultEmissions.orderId, orderId));
    const third = await runVaultEmissionStuckWatchdog({ thresholdMinutes: 15 });
    expect(third.notified).toBe(false);
    const [alert3] = await db
      .select()
      .from(watchdogAlertState)
      .where(eq(watchdogAlertState.watchdogName, 'vault-emission-stuck-watchdog'));
    expect(alert3?.alertActive).toBe(false);
  });

  // ─── ADR 031 V7 — admin re-drive support ────────────────────────────────

  it('V7: reclaims + redrives a failed-after-deposit emission to resume at transfer WITHOUT re-depositing (real postgres CAS + FOR UPDATE lock)', async () => {
    const user = await seedUser();
    const orderId = await seedOrder({ userId: user.id, cashbackMinor: 500n });

    const claimed = await claimVaultEmission(db as never, {
      orderId,
      userId: user.id,
      assetCode: 'LOOPUSD',
      network: 'testnet',
      cashbackMinor: 500n,
      toAddress: user.walletAddress,
    });
    expect(claimed).toBe(true);
    const [row] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.orderId, orderId));

    // Simulate a row that reached 'failed' AFTER a real deposit landed
    // (depositedAt set) but before the transfer did — same shape the
    // real `recordStepFailure`/terminal-attempts path produces; the
    // unit suite already proves that retry-counting path, so this
    // integration test's focus is the real-DB reclaim + resume.
    await db
      .update(vaultEmissions)
      .set({
        state: 'failed',
        depositTxHash: 'dep-v7',
        sharesMinted: 480n,
        depositedAt: new Date(),
        attempts: 5,
        lastError: 'Soroban RPC timeout',
        failedAt: new Date(),
      })
      .where(eq(vaultEmissions.id, row!.id));

    const { reclaimFailedVaultEmissionForRedrive } =
      await import('../../credits/vaults/vault-emissions.js');
    const reclaimed = await reclaimFailedVaultEmissionForRedrive(row!.id);
    expect(reclaimed.kind).toBe('reclaimed');
    if (reclaimed.kind !== 'reclaimed') throw new Error('unreachable');
    // Real-DB proof of the resume-state inference: depositedAt was set
    // (deposit landed) but transferredAt was not, so it resumes at
    // 'deposited' — never back to 'pending'/'depositing'.
    expect(reclaimed.row.state).toBe('deposited');
    expect(reclaimed.row.attempts).toBe(0);
    expect(reclaimed.row.lastError).toBeNull();
    expect(reclaimed.row.failedAt).toBeNull();

    vaultClientState.transferResult = { txHash: 'transfer-tx-v7' };
    const outcome = await driveOneVaultEmission(reclaimed.row);

    expect(outcome).toBe('mirrored');
    // The deposit client was NEVER invoked across this whole test — the
    // resume skipped straight to the transfer step.
    expect(vaultClientMocks.depositToVault).not.toHaveBeenCalled();

    const [finalRow] = await db.select().from(vaultEmissions).where(eq(vaultEmissions.id, row!.id));
    expect(finalRow?.state).toBe('mirrored');
    expect(finalRow?.transferTxHash).toBe('transfer-tx-v7');
    expect(finalRow?.depositTxHash).toBe('dep-v7'); // untouched from the original deposit

    const [balance] = await db
      .select()
      .from(userCredits)
      .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'USD')));
    expect(balance?.balanceMinor).toBe(500n);
  });

  it('V7 P1: the admin re-drive and the sweep are mutually exclusive — a second acquisition of vaultEmissionSweepLockKey() is refused while the first holds it (real postgres advisory lock)', async () => {
    // The fix's load-bearing claim: the admin re-drive acquires the
    // SAME fleet-wide lock the sweep single-flights on, so the two can
    // never drive the same row's un-CAS'd step concurrently. Prove it
    // against a real Postgres advisory lock (a DIRECT connection, so
    // withAdvisoryLock does NOT take its pooler-degradation branch):
    // while one holder (standing in for a running sweep tick) holds the
    // lock, a second acquisition of the SAME key (standing in for the
    // re-drive) returns `{ ran: false }` and never runs its fn.
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });

    const firstHolder = withAdvisoryLock(vaultEmissionSweepLockKey(), async () => {
      firstAcquired();
      await firstReleased; // hold the lock until the assertion below runs
      return 'sweep-ran';
    });

    // Wait until the first holder actually owns the lock before racing.
    await firstHasLock;

    let secondFnRan = false;
    const second = await withAdvisoryLock(vaultEmissionSweepLockKey(), async () => {
      secondFnRan = true;
      return 'redrive-ran';
    });
    // The second acquisition (the re-drive) is refused — the handler
    // maps this to 409 VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS.
    expect(second.ran).toBe(false);
    expect(secondFnRan).toBe(false);

    // Release the first holder; it ran to completion under the lock.
    releaseFirst();
    const firstResult = await firstHolder;
    expect(firstResult).toEqual({ ran: true, value: 'sweep-ran' });

    // And once released, the key is free again — a fresh acquisition succeeds.
    const third = await withAdvisoryLock(vaultEmissionSweepLockKey(), async () => 'ok');
    expect(third).toEqual({ ran: true, value: 'ok' });
  });
});
