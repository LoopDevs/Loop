/**
 * Wallet integration end-to-end walk — TESTNET (ADR 030 / 031 / 036).
 *
 * The pre-staging gate for the embedded-wallet stack: drives the REAL
 * modules (Privy REST adapter, sponsored activation, payout worker,
 * payment watcher, interest-mint worker) against Stellar TESTNET
 * Horizon, the real Privy app, and a scratch Postgres, then prints a
 * step-by-step PASS/FAIL report:
 *
 *   1.  create user → Privy wallet → operator-sponsored activation
 *   2.  seed mirror liability + emit an on-chain payout
 *       (operator-signed `kind='emission'` — GBPLOOP minted from the
 *       test issuer to the operator first if the float is short)
 *   3.  redeem (ADR 036 term, formerly pay-with-balance): user-signed
 *       inner tx (Privy rawSign) + operator fee-bump → deposit address
 *   4.  payment-watcher tick → order paid, mirror debited,
 *       issuer-return `kind='burn'` enqueued → payout tick confirms it
 *   5.  interest-mint tick → snapshot + interest credit +
 *       `kind='interest_mint'` row → payout tick confirms the
 *       issuer-SIGNED mint (tx source verified == issuer account)
 *
 * Idempotent: re-runs reuse the user/wallet (keyed by email), the
 * interest step treats "already minted this UTC period" as PASS, and
 * every on-chain step rides the same fences production uses.
 *
 * ── Required environment ────────────────────────────────────────────
 * (env.ts parses at import — set everything BEFORE running)
 *
 *   DATABASE_URL                          scratch Postgres — the walk writes
 *                                         users/orders/ledger rows; NEVER a
 *                                         production database
 *   GIFT_CARD_API_BASE_URL                required by env.ts; unused here —
 *                                         https://spend.ctx.com is fine
 *   LOOP_STELLAR_HORIZON_URL              https://horizon-testnet.stellar.org
 *   LOOP_STELLAR_NETWORK_PASSPHRASE       "Test SDF Network ; September 2015"
 *                                         (hard-required — the walk refuses
 *                                         to run against mainnet)
 *   LOOP_STELLAR_OPERATOR_SECRET          testnet operator secret (auto-funded
 *                                         via friendbot when the account is new)
 *   LOOP_STELLAR_DEPOSIT_ADDRESS          MUST equal the operator public key —
 *                                         the burn step forwards deposit-held
 *                                         LOOP from this account
 *   LOOP_STELLAR_GBPLOOP_ISSUER           testnet issuer public key
 *   LOOP_STELLAR_GBPLOOP_ISSUER_SECRET    matching issuer secret (boot-validated)
 *   LOOP_WALLET_PROVIDER=privy
 *   PRIVY_APP_ID / PRIVY_APP_SECRET       real Privy app credentials
 *   LOOP_INTEREST_ONCHAIN_ENABLED=true
 *   INTEREST_APY_BASIS_POINTS             non-zero, e.g. 300 (3.00% APY)
 *
 * Optional:
 *   WALK_USER_EMAIL          default wallet-walk@loopfinance.io
 *   WALK_EMISSION_MINOR      default 50000  (£500 emitted to the wallet)
 *   WALK_ORDER_CHARGE_MINOR  default 200    (£2 redeemed against an order)
 *
 * Run:  npm run walk:wallet-testnet -w @loop/backend
 */
/* eslint-disable no-console -- operator CLI: the PASS/FAIL report IS the output (same pattern as quarterly-tax.ts) */
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type FeeBumpTransaction,
} from '@stellar/stellar-sdk';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { env } from '../env.js';
import { db, runMigrations, closeDb } from '../db/client.js';
import {
  creditTransactions,
  interestMintSnapshots,
  orders,
  pendingPayouts,
  userCredits,
  users,
  watcherCursors,
} from '../db/schema.js';
import { generatePayoutMemo } from '../credits/payout-builder.js';
import { runInterestMintTick, utcPeriodCursor } from '../credits/interest-mint.js';
import { resolveIssuerSigners } from '../payments/issuer-signers.js';
import { runPayoutTick, resolvePayoutConfig } from '../payments/payout-worker.js';
import { runPaymentWatcherTick } from '../payments/watcher.js';
import { submitPayout, submitPreSignedTransaction } from '../payments/payout-submit.js';
import {
  getAccountTrustlines,
  __resetTrustlineCacheForTests,
} from '../payments/horizon-trustlines.js';
import { buildRedeemTransaction, feeBumpBaseFee } from '../orders/redeem.js';
import { getWalletProvider } from '../wallet/provider.js';
import { attachUserWalletSignature } from '../wallet/user-signer.js';
import { provisionUserWallet } from '../wallet/provisioning.js';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const FRIENDBOT = 'https://friendbot.stellar.org';
const STROOPS_PER_MINOR = 100_000n;

const USER_EMAIL = process.env['WALK_USER_EMAIL'] ?? 'wallet-walk@loopfinance.io';
const EMISSION_MINOR = BigInt(process.env['WALK_EMISSION_MINOR'] ?? '50000');
const ORDER_CHARGE_MINOR = BigInt(process.env['WALK_ORDER_CHARGE_MINOR'] ?? '200');

interface StepResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}
const report: StepResult[] = [];
function pass(name: string, detail: string): void {
  report.push({ name, status: 'PASS', detail });
  console.log(`  ✔ PASS  ${name} — ${detail}`);
}
function fail(name: string, detail: string): never {
  report.push({ name, status: 'FAIL', detail });
  console.error(`  ✘ FAIL  ${name} — ${detail}`);
  throw new WalkAbort();
}
class WalkAbort extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const server = new Horizon.Server(env.LOOP_STELLAR_HORIZON_URL);

async function accountExists(address: string): Promise<boolean> {
  try {
    await server.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

async function ensureFunded(address: string, label: string): Promise<void> {
  if (await accountExists(address)) return;
  console.log(`  … funding ${label} (${address.slice(0, 8)}…) via friendbot`);
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(address)}`);
  if (!res.ok) {
    fail('account funding', `friendbot returned ${res.status} for ${label}`);
  }
}

/** Fresh (uncached) trustline snapshot. */
async function freshTrustlines(
  address: string,
): Promise<Awaited<ReturnType<typeof getAccountTrustlines>>> {
  __resetTrustlineCacheForTests();
  return getAccountTrustlines(address);
}

async function ensureTrustline(secret: string, asset: Asset, label: string): Promise<void> {
  const kp = Keypair.fromSecret(secret);
  const snapshot = await freshTrustlines(kp.publicKey());
  if (snapshot.trustlines.has(`${asset.getCode()}::${asset.getIssuer()}`)) return;
  console.log(`  … opening ${asset.getCode()} trustline on ${label}`);
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await submitPreSignedTransaction({ horizonUrl: env.LOOP_STELLAR_HORIZON_URL, tx });
}

/** Drives payout ticks until `predicate` sees the row leave the queue. */
async function drainPayouts(
  payoutConfig: NonNullable<ReturnType<typeof resolvePayoutConfig>>,
  payoutId: string,
  stepName: string,
): Promise<{ txHash: string }> {
  for (let i = 0; i < 12; i++) {
    await runPayoutTick({ ...payoutConfig, limit: 10 });
    const [row] = await db
      .select({ state: pendingPayouts.state, txHash: pendingPayouts.txHash })
      .from(pendingPayouts)
      .where(eq(pendingPayouts.id, payoutId));
    if (row === undefined) fail(stepName, `payout row ${payoutId} disappeared`);
    if (row.state === 'confirmed') return { txHash: row.txHash ?? '(missing)' };
    if (row.state === 'failed') fail(stepName, `payout row ${payoutId} marked failed`);
    await sleep(3_000);
  }
  fail(stepName, `payout row ${payoutId} did not confirm within 12 ticks`);
}

async function main(): Promise<void> {
  console.log('Wallet testnet walk — ADR 030/031/036 end-to-end\n');

  // ── Step 0: guard rails ───────────────────────────────────────────
  if (env.LOOP_STELLAR_NETWORK_PASSPHRASE !== TESTNET_PASSPHRASE) {
    fail(
      'guard rails',
      `network passphrase is not testnet ("${env.LOOP_STELLAR_NETWORK_PASSPHRASE}") — refusing`,
    );
  }
  if (env.LOOP_STELLAR_OPERATOR_SECRET === undefined) {
    fail('guard rails', 'LOOP_STELLAR_OPERATOR_SECRET is unset');
  }
  const operatorKp = Keypair.fromSecret(env.LOOP_STELLAR_OPERATOR_SECRET);
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS !== operatorKp.publicKey()) {
    fail(
      'guard rails',
      `LOOP_STELLAR_DEPOSIT_ADDRESS must equal the operator public key (${operatorKp.publicKey()}) — the burn step forwards deposit-held LOOP from that account`,
    );
  }
  const issuerSigners = resolveIssuerSigners();
  const gbpSigner = issuerSigners.get('GBPLOOP');
  if (gbpSigner === undefined || env.LOOP_STELLAR_GBPLOOP_ISSUER === undefined) {
    fail('guard rails', 'LOOP_STELLAR_GBPLOOP_ISSUER + _ISSUER_SECRET must both be set');
  }
  if (!env.LOOP_INTEREST_ONCHAIN_ENABLED || env.INTEREST_APY_BASIS_POINTS <= 0) {
    fail(
      'guard rails',
      'LOOP_INTEREST_ONCHAIN_ENABLED=true and INTEREST_APY_BASIS_POINTS>0 are required',
    );
  }
  const provider = getWalletProvider();
  if (provider === null) {
    fail('guard rails', 'LOOP_WALLET_PROVIDER=privy (+ PRIVY_APP_ID/PRIVY_APP_SECRET) is required');
  }
  const gbploop = new Asset('GBPLOOP', env.LOOP_STELLAR_GBPLOOP_ISSUER);
  pass('guard rails', `testnet ✓, issuer signer ✓, provider=${provider.name}`);

  // ── Step 1: migrations + Stellar accounts ─────────────────────────
  await runMigrations();
  await ensureFunded(operatorKp.publicKey(), 'operator');
  await ensureFunded(gbpSigner.account, 'issuer');
  await ensureTrustline(env.LOOP_STELLAR_OPERATOR_SECRET, gbploop, 'operator');
  pass('substrate', 'migrations applied; operator + issuer live with GBPLOOP trustline');

  // ── Step 2: user + Privy wallet + sponsored activation ────────────
  let [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, USER_EMAIL), isNull(users.ctxUserId)));
  if (user === undefined) {
    [user] = await db.insert(users).values({ email: USER_EMAIL, homeCurrency: 'GBP' }).returning();
  }
  if (user === undefined) fail('user', 'failed to create the walk user row');
  const outcome = await provisionUserWallet(user.id);
  if (outcome !== 'activated' && outcome !== 'already_activated') {
    fail('provisioning', `provisionUserWallet returned '${outcome}'`);
  }
  const [provisioned] = await db.select().from(users).where(eq(users.id, user.id));
  const walletAddress = provisioned?.walletAddress ?? null;
  if (provisioned === undefined || walletAddress === null) {
    fail('provisioning', 'user row has no wallet_address after activation');
  }
  const activationSnap = await freshTrustlines(walletAddress);
  if (
    !activationSnap.accountExists ||
    !activationSnap.trustlines.has(`GBPLOOP::${gbploop.getIssuer()}`)
  ) {
    fail('provisioning', `wallet ${walletAddress} is missing its on-chain GBPLOOP trustline`);
  }
  pass('provisioning', `wallet ${walletAddress.slice(0, 8)}… activated (${outcome})`);

  // ── Step 3: operator float + mirror liability + emission ─────────
  const operatorSnap = await freshTrustlines(operatorKp.publicKey());
  const operatorFloat =
    operatorSnap.trustlines.get(`GBPLOOP::${gbploop.getIssuer()}`)?.balanceStroops ?? 0n;
  const emissionStroops = EMISSION_MINOR * STROOPS_PER_MINOR;
  if (operatorFloat < emissionStroops) {
    console.log('  … minting GBPLOOP float from the test issuer to the operator');
    await submitPayout({
      secret: gbpSigner.secret,
      horizonUrl: env.LOOP_STELLAR_HORIZON_URL,
      networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
      intent: {
        to: operatorKp.publicKey(),
        assetCode: 'GBPLOOP',
        assetIssuer: gbploop.getIssuer(),
        amountStroops: emissionStroops - operatorFloat,
        memoText: generatePayoutMemo(),
      },
    });
  }
  // ADR 036: an emission backfills the on-chain half of EXISTING
  // mirror liability — seed that liability first (admin-adjustment
  // shaped ledger row + balance bump, exactly what a support credit
  // would write).
  await db.transaction(async (tx) => {
    await tx.insert(creditTransactions).values({
      userId: user.id,
      type: 'adjustment',
      amountMinor: EMISSION_MINOR,
      currency: 'GBP',
      referenceType: null,
      referenceId: null,
      reason: 'wallet-testnet-walk: seed liability for emission',
    });
    await tx
      .insert(userCredits)
      .values({ userId: user.id, currency: 'GBP', balanceMinor: EMISSION_MINOR })
      .onConflictDoUpdate({
        target: [userCredits.userId, userCredits.currency],
        set: {
          balanceMinor: sql`${userCredits.balanceMinor} + ${EMISSION_MINOR}`,
          updatedAt: sql`NOW()`,
        },
      });
  });
  // Reuse an in-flight emission from a crashed prior run (the
  // active-emission unique fence would reject a duplicate insert).
  let [emission] = await db
    .select()
    .from(pendingPayouts)
    .where(
      sql`${pendingPayouts.userId} = ${user.id}
        AND ${pendingPayouts.kind} = 'emission'
        AND ${pendingPayouts.toAddress} = ${walletAddress}
        AND ${pendingPayouts.amountStroops} = ${emissionStroops}
        AND ${pendingPayouts.state} IN ('pending', 'submitted')`,
    );
  if (emission === undefined) {
    [emission] = await db
      .insert(pendingPayouts)
      .values({
        userId: user.id,
        orderId: null,
        kind: 'emission',
        assetCode: 'GBPLOOP',
        assetIssuer: gbploop.getIssuer(),
        toAddress: walletAddress,
        amountStroops: emissionStroops,
        memoText: generatePayoutMemo(),
      })
      .returning();
  }
  if (emission === undefined) fail('emission', 'failed to enqueue the emission payout row');
  const payoutConfig = resolvePayoutConfig();
  if (payoutConfig === null) fail('emission', 'resolvePayoutConfig() returned null');
  const emissionTx = await drainPayouts(payoutConfig, emission.id, 'emission');
  const postEmission = await freshTrustlines(walletAddress);
  const walletBalance =
    postEmission.trustlines.get(`GBPLOOP::${gbploop.getIssuer()}`)?.balanceStroops ?? 0n;
  if (walletBalance < emissionStroops) {
    fail('emission', `wallet holds ${walletBalance} stroops, expected ≥ ${emissionStroops}`);
  }
  pass(
    'emission',
    `${EMISSION_MINOR} minor GBPLOOP on-chain (tx ${emissionTx.txHash.slice(0, 8)}…)`,
  );

  // ── Step 4: loop_asset order + redeem ────────────────────────────
  const paymentMemo = generatePayoutMemo();
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      merchantId: 'wallet-testnet-walk',
      faceValueMinor: ORDER_CHARGE_MINOR,
      currency: 'GBP',
      chargeMinor: ORDER_CHARGE_MINOR,
      chargeCurrency: 'GBP',
      paymentMethod: 'loop_asset',
      paymentMemo,
      wholesalePct: '0.00',
      userCashbackPct: '0.00',
      loopMarginPct: '0.00',
      wholesaleMinor: 0n,
      userCashbackMinor: 0n,
      loopMarginMinor: 0n,
      state: 'pending_payment',
    })
    .returning();
  if (order === undefined) fail('order', 'failed to insert the walk order');

  // Pre-seed the deposit-watcher cursor on first run so the tick
  // doesn't page through the operator account's full testnet history.
  const [cursorRow] = await db
    .select({ cursor: watcherCursors.cursor })
    .from(watcherCursors)
    .where(eq(watcherCursors.name, 'stellar-deposits'));
  if (cursorRow === undefined) {
    const page = await fetch(
      `${env.LOOP_STELLAR_HORIZON_URL}/accounts/${operatorKp.publicKey()}/payments?order=desc&limit=1`,
      { headers: { Accept: 'application/hal+json' } },
    ).then(
      (r) => r.json() as Promise<{ _embedded?: { records?: Array<{ paging_token: string }> } }>,
    );
    const latest = page._embedded?.records?.[0]?.paging_token;
    if (latest !== undefined) {
      await db.insert(watcherCursors).values({ name: 'stellar-deposits', cursor: latest });
    }
  }

  // The redeem core (handler minus HTTP): user-signed inner
  // payment, operator fee-bump, classify-path submit.
  const loaded = await server.loadAccount(walletAddress);
  const innerTx = buildRedeemTransaction({
    userAccount: new Account(walletAddress, loaded.sequenceNumber()),
    depositAddress: env.LOOP_STELLAR_DEPOSIT_ADDRESS,
    asset: { code: 'GBPLOOP', issuer: gbploop.getIssuer() },
    amountStroops: ORDER_CHARGE_MINOR * STROOPS_PER_MINOR,
    memoText: paymentMemo,
    networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
  });
  const walletId = provisioned.walletId;
  if (walletId === null) fail('redemption', 'user row has no wallet_id');
  await attachUserWalletSignature({ provider, walletId, address: walletAddress, tx: innerTx });
  const feeBump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
    operatorKp,
    feeBumpBaseFee(),
    innerTx,
    env.LOOP_STELLAR_NETWORK_PASSPHRASE,
  );
  feeBump.sign(operatorKp);
  const redemptionSubmit = await submitPreSignedTransaction({
    horizonUrl: env.LOOP_STELLAR_HORIZON_URL,
    tx: feeBump,
  });
  pass(
    'redemption submit',
    `user-signed + fee-bumped (tx ${redemptionSubmit.txHash.slice(0, 8)}…)`,
  );

  // ── Step 5: watcher tick → paid + mirror debit + burn row ─────────
  const [mirrorBefore] = await db
    .select({ balanceMinor: userCredits.balanceMinor })
    .from(userCredits)
    .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'GBP')));
  let paid = false;
  for (let i = 0; i < 10 && !paid; i++) {
    await runPaymentWatcherTick({ account: env.LOOP_STELLAR_DEPOSIT_ADDRESS });
    const [fresh] = await db
      .select({ state: orders.state })
      .from(orders)
      .where(eq(orders.id, order.id));
    paid = fresh?.state === 'paid';
    if (!paid) await sleep(3_000);
  }
  if (!paid) fail('watcher', `order ${order.id} never reached state='paid'`);
  const [mirrorAfter] = await db
    .select({ balanceMinor: userCredits.balanceMinor })
    .from(userCredits)
    .where(and(eq(userCredits.userId, user.id), eq(userCredits.currency, 'GBP')));
  const debited = (mirrorBefore?.balanceMinor ?? 0n) - (mirrorAfter?.balanceMinor ?? 0n);
  if (debited !== ORDER_CHARGE_MINOR) {
    fail('mirror debit', `mirror moved by ${debited} minor, expected ${ORDER_CHARGE_MINOR}`);
  }
  const [burn] = await db
    .select()
    .from(pendingPayouts)
    .where(and(eq(pendingPayouts.orderId, order.id), eq(pendingPayouts.kind, 'burn')));
  if (burn === undefined) fail('burn row', 'markOrderPaid did not enqueue the issuer-return burn');
  pass('watcher + mirror', `order paid; mirror debited ${debited} minor; burn row queued`);

  const burnTx = await drainPayouts(payoutConfig, burn.id, 'burn confirm');
  pass('burn confirm', `issuer-return landed (tx ${burnTx.txHash.slice(0, 8)}…)`);

  // ── Step 6: interest-mint tick → snapshot + credit + mint row ─────
  __resetTrustlineCacheForTests();
  const period = utcPeriodCursor();
  const tick = await runInterestMintTick();
  const [snapshotRow] = await db
    .select()
    .from(interestMintSnapshots)
    .where(
      and(
        eq(interestMintSnapshots.userId, user.id),
        eq(interestMintSnapshots.assetCode, 'GBPLOOP'),
        eq(interestMintSnapshots.periodCursor, period),
      ),
    );
  if (snapshotRow === undefined) {
    fail(
      'interest tick',
      `no interest_mint_snapshots row for period ${period} (tick: ${JSON.stringify({ minted: tick.minted, skippedAlready: tick.skippedAlready, errors: tick.errors })})`,
    );
  }
  if (snapshotRow.mintedMinor > 0n) {
    const [interestRow] = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, user.id),
          eq(creditTransactions.type, 'interest'),
          eq(creditTransactions.periodCursor, period),
        ),
      );
    if (interestRow === undefined || interestRow.amountMinor !== snapshotRow.mintedMinor) {
      fail('interest ledger', 'interest credit_transactions row missing or amount-mismatched');
    }
    const [mintRow] = await db
      .select()
      .from(pendingPayouts)
      .where(
        sql`${pendingPayouts.userId} = ${user.id}
          AND ${pendingPayouts.kind} = 'interest_mint'
          AND ${pendingPayouts.state} IN ('pending', 'submitted', 'confirmed')`,
      )
      .orderBy(desc(pendingPayouts.createdAt))
      .limit(1);
    if (
      mintRow === undefined ||
      mintRow.amountStroops !== snapshotRow.mintedMinor * STROOPS_PER_MINOR
    ) {
      fail('interest mint row', 'interest_mint payout row missing or amount-mismatched');
    }
    pass(
      'interest tick',
      `snapshot balance=${snapshotRow.balanceStroops} stroops, minted=${snapshotRow.mintedMinor} minor, carry=${snapshotRow.carryAfterStroops}`,
    );

    // ── Step 7: confirm the mint and verify the issuer signed it ────
    const before = await freshTrustlines(walletAddress);
    const beforeBal =
      before.trustlines.get(`GBPLOOP::${gbploop.getIssuer()}`)?.balanceStroops ?? 0n;
    const mintTx = await drainPayouts(payoutConfig, mintRow.id, 'mint confirm');
    const after = await freshTrustlines(walletAddress);
    const afterBal = after.trustlines.get(`GBPLOOP::${gbploop.getIssuer()}`)?.balanceStroops ?? 0n;
    if (afterBal - beforeBal !== snapshotRow.mintedMinor * STROOPS_PER_MINOR) {
      fail(
        'mint verify',
        `wallet grew by ${afterBal - beforeBal} stroops, expected ${snapshotRow.mintedMinor * STROOPS_PER_MINOR}`,
      );
    }
    const txDetail = await fetch(`${env.LOOP_STELLAR_HORIZON_URL}/transactions/${mintTx.txHash}`, {
      headers: { Accept: 'application/hal+json' },
    }).then((r) => r.json() as Promise<{ source_account?: string }>);
    if (txDetail.source_account !== gbpSigner.account) {
      fail(
        'mint signer',
        `mint tx source is ${txDetail.source_account ?? '(none)'}, expected the issuer ${gbpSigner.account}`,
      );
    }
    pass(
      'mint confirm',
      `issuer-signed mint landed (tx ${mintTx.txHash.slice(0, 8)}…), wallet +${afterBal - beforeBal} stroops`,
    );
  } else if (tick.skippedAlready > 0 || tick.alreadyProcessed) {
    pass(
      'interest tick',
      `period ${period} already minted for this user — idempotency fence held (re-run)`,
    );
  } else {
    pass(
      'interest tick',
      `accrue-only night: accrual=${snapshotRow.accrualStroops} stroops carried (sub-minor); raise WALK_EMISSION_MINOR or APY to exercise a same-night mint`,
    );
  }
}

function printReport(): boolean {
  console.log('\n──────── wallet testnet walk report ────────');
  for (const r of report) {
    console.log(`  ${r.status.padEnd(4)}  ${r.name} — ${r.detail}`);
  }
  const failed = report.some((r) => r.status === 'FAIL');
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS — wallet stack validated on testnet');
  return !failed;
}

try {
  await main();
} catch (err) {
  if (!(err instanceof WalkAbort)) {
    console.error('\nUnexpected error:', err);
    report.push({ name: 'unexpected error', status: 'FAIL', detail: String(err) });
  }
} finally {
  const ok = printReport();
  await closeDb().catch(() => undefined);
  process.exit(ok ? 0 : 1);
}
