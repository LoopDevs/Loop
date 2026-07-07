/**
 * Embedded-wallet provisioning (ADR 030 Phase C1).
 *
 * Drives the `users.wallet_provisioning` state machine
 * (`none → wallet_created → activated`, migration 0040):
 *
 *   1. **wallet_created** — `provider.createWallet(userId)` (idempotent
 *      per user on the provider side) and the resulting
 *      `walletId` / `address` are persisted to the user row.
 *   2. **activated** — ONE operator-sourced sponsored transaction:
 *
 *        beginSponsoringFutureReserves(sponsored: user)   [src operator]
 *        createAccount(user, startingBalance: '0')        [src operator]
 *        changeTrust(LOOP asset) × configured assets      [src user]
 *        endSponsoringFutureReserves()                    [src user]
 *
 *      Operator signs locally; the user's signature comes from the
 *      Phase-B bridge (`attachUserWalletSignature` → provider rawSign,
 *      locally verified); submit goes through the ADR-016
 *      `submitPreSignedTransaction` classify path. The account ends up
 *      live with zero XLM and every reserve sponsored by the operator
 *      — the user can never spend reserve XLM because there is none.
 *
 * Idempotent: before building the activation tx we read the account
 * from Horizon — an account that already exists with every configured
 * trustline is detect-and-marked `activated` without a transaction
 * (covers the crash-after-submit-before-persist window and operator
 * manual fixes). An existing account missing trustlines gets a
 * sponsored changeTrust-only transaction (createAccount omitted).
 *
 * Drivers:
 *   - `enqueueWalletProvisioning` — fire-and-forget post-signup hook
 *     (verify-otp / social). Signup NEVER blocks on Stellar: the
 *     promise is detached and all failures land in the sweeper's
 *     retry path.
 *   - the provisioning sweeper (`runWalletProvisioningTick`) — 60s
 *     tick re-driving stuck rows with exponential backoff (same
 *     pattern as the redemption backfill) and backfilling existing
 *     users that already hold `user_credits`. Exhaustion pages ops
 *     via `notifyWalletProvisioningStuck` —
 *     runbook: docs/runbooks/wallet-provisioning-stuck.md.
 */
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, withAdvisoryLock } from '../db/client.js';
import { users, type WalletProvisioningState } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { notifyWalletProvisioningStuck } from '../discord.js';
import { configuredLoopPayableAssets } from '../credits/payout-asset.js';
import { feeForAttempt } from '../payments/fee-strategy.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';
import { submitPreSignedTransaction } from '../payments/payout-submit.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { getWalletProvider } from './provider.js';
import { attachUserWalletSignature } from './user-signer.js';

const log = logger.child({ area: 'wallet-provisioning' });

/**
 * Hard cap on provisioning attempts per user. With the backoff
 * schedule below the tenth attempt lands ~17h after the first
 * failure — past that the row is a config / provider-account problem
 * (Privy auth, operator funding, Horizon outage that long), not a
 * retry problem; ops is paged instead.
 */
export const WALLET_PROVISIONING_MAX_ATTEMPTS = 10;

/** Backoff base: delay before attempt n+1 is `base · 2^n`, capped below. */
const WALLET_PROVISIONING_BASE_DELAY_MS = 60_000;
const WALLET_PROVISIONING_MAX_DELAY_MS = 8 * 60 * 60 * 1000;

/** Sweeper cadence. Mirrors the redemption-backfill sweeper. */
export const WALLET_PROVISIONING_INTERVAL_MS = 60_000;

/** Max candidate rows considered per tick. */
const WALLET_PROVISIONING_BATCH_LIMIT = 10;

/** Activation tx timebound — matches ADR 016's payout-submit default. */
const ACTIVATION_TIMEOUT_SECONDS = 60;

/** Delay before the (attempts+1)-th attempt is due. Exported for tests. */
export function walletProvisioningDelayMs(attempts: number): number {
  const exp = Math.min(attempts, 30); // 2^30 guard against overflow noise
  return Math.min(WALLET_PROVISIONING_BASE_DELAY_MS * 2 ** exp, WALLET_PROVISIONING_MAX_DELAY_MS);
}

function walletProvisioningLockKey(): bigint {
  const digest = createHash('sha256').update('loop:wallet-provisioning-sweeper').digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

// ─── Activation transaction builder (pure) ──────────────────────────────────

export interface BuildActivationArgs {
  /** Operator account loaded from Horizon (source + sequence). */
  operatorAccount: Account;
  /** The user's embedded-wallet Stellar address (G...). */
  userAddress: string;
  /** Configured LOOP assets to open trustlines for. Must be non-empty. */
  assets: ReadonlyArray<{ code: string; issuer: string }>;
  /**
   * False when Horizon 404'd the account — include the sponsored
   * `createAccount(0 XLM)`. True (account exists, trustlines missing)
   * → changeTrust-only re-activation.
   */
  accountExists: boolean;
  networkPassphrase: string;
  /** Per-operation fee in stroops, as a string (SDK contract). */
  feeStroops: string;
  timeoutSeconds?: number;
}

/**
 * Builds (does NOT sign) the sponsored-activation transaction.
 * Pure given a pre-loaded operator `Account`, so tests can pin the
 * envelope shape — op order, sponsorship pairing, per-op sources —
 * without Horizon.
 */
export function buildActivationTransaction(args: BuildActivationArgs): Transaction {
  if (args.assets.length === 0) {
    throw new Error('buildActivationTransaction: at least one LOOP asset is required');
  }
  const builder = new TransactionBuilder(args.operatorAccount, {
    fee: args.feeStroops,
    networkPassphrase: args.networkPassphrase,
  });
  // Sponsorship sandwich: every reserve created between begin/end is
  // paid by the operator. Source on begin is the operator (the
  // transaction source — omitted); the sandwich is closed by the USER
  // so the user's signature covers it (required by CAP-33: end must
  // be authorised by the sponsored account... strictly, end's source
  // is the account whose "is-sponsored" state ends — the user).
  builder.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: args.userAddress }));
  if (!args.accountExists) {
    builder.addOperation(
      Operation.createAccount({ destination: args.userAddress, startingBalance: '0' }),
    );
  }
  for (const asset of args.assets) {
    builder.addOperation(
      Operation.changeTrust({
        asset: new Asset(asset.code, asset.issuer),
        source: args.userAddress,
      }),
    );
  }
  builder.addOperation(Operation.endSponsoringFutureReserves({ source: args.userAddress }));
  return builder.setTimeout(args.timeoutSeconds ?? ACTIVATION_TIMEOUT_SECONDS).build();
}

// ─── State-machine drive ────────────────────────────────────────────────────

export type ProvisionOutcome =
  /** User row missing — nothing to do (deleted between pick + drive). */
  | 'user_not_found'
  /** Already `activated` — no-op. */
  | 'already_activated'
  /** `LOOP_WALLET_PROVIDER` is '' — the wallet layer is off. */
  | 'provider_disabled'
  /** No LOOP issuer configured — activation can't open trustlines. */
  | 'no_assets_configured'
  /** `LOOP_STELLAR_OPERATOR_SECRET` unset — nobody can sponsor. */
  | 'operator_unconfigured'
  /** Account live with all trustlines (freshly submitted or detected). */
  | 'activated';

interface ProvisioningUserRow {
  id: string;
  walletId: string | null;
  walletAddress: string | null;
  walletProvisioning: WalletProvisioningState;
  walletProvisioningAttempts: number;
}

async function readProvisioningRow(userId: string): Promise<ProvisioningUserRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      walletId: users.walletId,
      walletAddress: users.walletAddress,
      walletProvisioning: users.walletProvisioning,
      walletProvisioningAttempts: users.walletProvisioningAttempts,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

/**
 * Persists the provider wallet onto the user row and advances
 * `none → wallet_created`. Guarded on `wallet_id IS NULL` so a
 * concurrent drive can't clobber an existing linkage; losing the
 * race is a no-op (the winner persisted the same provider wallet —
 * `createWallet` is idempotent per user).
 */
async function persistWalletCreated(
  userId: string,
  wallet: { walletId: string; address: string },
): Promise<void> {
  await db
    .update(users)
    .set({
      walletProvider: 'privy',
      walletId: wallet.walletId,
      walletAddress: wallet.address,
      walletProvisioning: 'wallet_created',
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(users.id, userId), isNull(users.walletId)));
}

/** Advances to `activated`. Idempotent — re-marking is a no-op. */
async function markActivated(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ walletProvisioning: 'activated', updatedAt: sql`NOW()` })
    .where(and(eq(users.id, userId), ne(users.walletProvisioning, 'activated')));
}

/**
 * Drives one user's provisioning as far as it can go in one pass.
 * Throws on provider / Horizon / submit failures (the caller's retry
 * policy decides what to do); returns a `ProvisionOutcome` for
 * everything that resolved cleanly.
 *
 * Config-shaped outcomes (`provider_disabled`, `no_assets_configured`,
 * `operator_unconfigured`) deliberately do NOT throw: they're the
 * operator's problem, not the user's, so the sweeper must not burn
 * the row's retry budget on them.
 */
export async function provisionUserWallet(userId: string): Promise<ProvisionOutcome> {
  const provider = getWalletProvider();
  if (provider === null) return 'provider_disabled';

  let row = await readProvisioningRow(userId);
  if (row === null) return 'user_not_found';
  if (row.walletProvisioning === 'activated') return 'already_activated';

  // Step 1: provider wallet. Idempotent on the provider side
  // (query-before-create + deterministic idempotency key), so
  // re-driving a half-finished row converges on the same wallet.
  if (row.walletId === null || row.walletAddress === null) {
    const wallet = await provider.createWallet(userId);
    await persistWalletCreated(userId, wallet);
    row = await readProvisioningRow(userId);
    if (row === null) return 'user_not_found';
  }
  const walletId = row.walletId;
  const walletAddress = row.walletAddress;
  if (walletId === null || walletAddress === null) {
    // persistWalletCreated raced a concurrent writer that hasn't
    // committed yet — treat as transient and let the sweeper retry.
    throw new Error(`wallet linkage not yet visible for user ${userId}`);
  }

  // Step 2: activation. Requires LOOP assets to trust and an
  // operator to sponsor + sign.
  const assets = configuredLoopPayableAssets();
  if (assets.length === 0) return 'no_assets_configured';
  const operatorSecret = env.LOOP_STELLAR_OPERATOR_SECRET;
  if (operatorSecret === undefined) return 'operator_unconfigured';

  // Idempotency pre-check: an account that already exists with every
  // configured trustline was activated by a prior (crashed or raced)
  // drive — detect and mark, never re-submit.
  const snapshot = await getAccountTrustlines(walletAddress);
  const missing = assets.filter((a) => !snapshot.trustlines.has(`${a.code}::${a.issuer}`));
  if (snapshot.accountExists && missing.length === 0) {
    await markActivated(userId);
    log.info({ userId }, 'Wallet account already live with all trustlines — marked activated');
    return 'activated';
  }

  const operatorKeypair = Keypair.fromSecret(operatorSecret);
  const server = new Horizon.Server(env.LOOP_STELLAR_HORIZON_URL);
  // Fresh sequence on every drive (ADR 016 discipline) — a stale seq
  // from a prior timeout can't poison the retry.
  const operatorAccount = await server.loadAccount(operatorKeypair.publicKey());

  const tx = buildActivationTransaction({
    operatorAccount,
    userAddress: walletAddress,
    // Existing account → only the missing trustlines; fresh account
    // → all of them.
    assets: snapshot.accountExists ? missing : assets,
    accountExists: snapshot.accountExists,
    networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
    feeStroops: feeForAttempt(row.walletProvisioningAttempts + 1, {
      baseFeeStroops: env.LOOP_PAYOUT_FEE_BASE_STROOPS,
      capFeeStroops: env.LOOP_PAYOUT_FEE_CAP_STROOPS,
      multiplier: env.LOOP_PAYOUT_FEE_MULTIPLIER,
    }),
  });
  // Operator signs locally; the user's signature is fetched from the
  // provider and verified against the wallet address BEFORE being
  // attached (Phase-B bridge invariant).
  tx.sign(operatorKeypair);
  await attachUserWalletSignature({ provider, walletId, address: walletAddress, tx });
  const result = await submitPreSignedTransaction({
    horizonUrl: env.LOOP_STELLAR_HORIZON_URL,
    tx,
  });
  await markActivated(userId);
  log.info(
    { userId, txHash: result.txHash, trustlines: assets.length },
    'Wallet activated — sponsored account live with LOOP trustlines',
  );
  return 'activated';
}

/**
 * Fire-and-forget signup hook. Synchronous + never throws: the
 * caller (verify-otp / social-login handler) must not block its
 * response on Stellar or the provider. Any failure is logged and
 * left to the sweeper, which re-drives the row with backoff (the
 * user row's `wallet_provisioning != 'activated'` is the queue).
 */
export function enqueueWalletProvisioning(userId: string): void {
  if (getWalletProvider() === null) return;
  void provisionUserWallet(userId)
    .then(async (outcome) => {
      if (outcome === 'activated' || outcome === 'already_activated') return;
      log.info({ userId, outcome }, 'Signup wallet provisioning deferred to sweeper');
    })
    .catch(async (err: unknown) => {
      log.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'Signup wallet provisioning failed — sweeper will retry with backoff',
      );
      await recordFailedAttempt(userId).catch(() => undefined);
    });
}

/**
 * Bumps the attempts counter + last-attempt timestamp after a failed
 * drive, paging ops once when the bump crosses the cap. The
 * compare-and-set attempts guard keeps a racing sweeper/signup pair
 * from double-counting (and double-paging) one attempt.
 */
async function recordFailedAttempt(userId: string): Promise<void> {
  const row = await readProvisioningRow(userId);
  if (row === null || row.walletProvisioning === 'activated') return;
  const nextAttempts = row.walletProvisioningAttempts + 1;
  const updated = await db
    .update(users)
    .set({
      walletProvisioningAttempts: nextAttempts,
      walletProvisioningLastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(users.id, userId),
        eq(users.walletProvisioningAttempts, row.walletProvisioningAttempts),
      ),
    )
    .returning({ id: users.id });
  if (updated.length === 0) return; // raced — the other writer owns the bump
  if (nextAttempts >= WALLET_PROVISIONING_MAX_ATTEMPTS) {
    log.error(
      { userId, attempts: nextAttempts },
      'Wallet provisioning exhausted — user has no activated wallet after max attempts',
    );
    notifyWalletProvisioningStuck({
      userId,
      walletId: row.walletId,
      walletAddress: row.walletAddress,
      provisioning: row.walletProvisioning,
      attempts: nextAttempts,
    });
  }
}

// ─── Sweeper ────────────────────────────────────────────────────────────────

export interface WalletProvisioningTickResult {
  /** True when another machine held the fleet-wide sweeper lock. */
  skippedLocked: boolean;
  /** Candidate rows matched by the SQL filter (pre-backoff). */
  picked: number;
  /** Rows skipped because their backoff window hasn't elapsed yet. */
  notDueYet: number;
  /** Rows that reached `activated` this tick. */
  activated: number;
  /** Rows whose drive threw (attempts bumped; alert on cap). */
  errors: number;
  /** True when the tick aborted early on missing operator/provider/asset config. */
  abortedUnconfigured: boolean;
}

/**
 * Single sweep pass. Candidates are not-yet-activated users that
 * either already started provisioning (`wallet_id IS NOT NULL` —
 * signup hook got partway) or hold a `user_credits` row (the
 * existing-user backfill population: they have cashback liability
 * waiting on a payout destination). Brand-new users with no credits
 * are the signup hook's job — nothing on-chain needs them yet.
 */
export async function runWalletProvisioningTick(args?: {
  limit?: number;
  now?: number;
}): Promise<WalletProvisioningTickResult> {
  const locked = await withAdvisoryLock(walletProvisioningLockKey(), () =>
    runWalletProvisioningTickLocked(args),
  );
  if (!locked.ran) {
    return {
      skippedLocked: true,
      picked: 0,
      notDueYet: 0,
      activated: 0,
      errors: 0,
      abortedUnconfigured: false,
    };
  }
  return locked.value;
}

async function runWalletProvisioningTickLocked(args?: {
  limit?: number;
  now?: number;
}): Promise<WalletProvisioningTickResult> {
  const now = args?.now ?? Date.now();
  const result: WalletProvisioningTickResult = {
    skippedLocked: false,
    picked: 0,
    notDueYet: 0,
    activated: 0,
    errors: 0,
    abortedUnconfigured: false,
  };
  if (getWalletProvider() === null) {
    result.abortedUnconfigured = true;
    return result;
  }

  const rows = await db
    .select({
      id: users.id,
      attempts: users.walletProvisioningAttempts,
      lastAttemptAt: users.walletProvisioningLastAttemptAt,
    })
    .from(users)
    .where(
      and(
        ne(users.walletProvisioning, 'activated'),
        lt(users.walletProvisioningAttempts, WALLET_PROVISIONING_MAX_ATTEMPTS),
        or(
          isNotNull(users.walletId),
          sql`EXISTS (SELECT 1 FROM user_credits uc WHERE uc.user_id = ${users.id})`,
        ),
      ),
    )
    .orderBy(users.createdAt)
    .limit(args?.limit ?? WALLET_PROVISIONING_BATCH_LIMIT);
  result.picked = rows.length;

  for (const row of rows) {
    if (
      row.lastAttemptAt !== null &&
      now - row.lastAttemptAt.getTime() < walletProvisioningDelayMs(row.attempts)
    ) {
      result.notDueYet++;
      continue;
    }
    try {
      const outcome = await provisionUserWallet(row.id);
      if (outcome === 'activated' || outcome === 'already_activated') {
        result.activated++;
        continue;
      }
      if (
        outcome === 'no_assets_configured' ||
        outcome === 'operator_unconfigured' ||
        outcome === 'provider_disabled'
      ) {
        // Deployment-level gap — every subsequent row hits the same
        // wall, and it isn't evidence against any single user's row.
        // Abort WITHOUT bumping attempts.
        log.warn({ outcome }, 'Wallet provisioning unconfigured — aborting tick');
        result.abortedUnconfigured = true;
        break;
      }
    } catch (err) {
      log.warn(
        { userId: row.id, err: err instanceof Error ? err.message : String(err) },
        'Wallet provisioning drive failed — attempt recorded, will retry with backoff',
      );
      result.errors++;
      await recordFailedAttempt(row.id);
    }
  }
  return result;
}

// ─── Interval loop ──────────────────────────────────────────────────────────

let provisioningTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic provisioning sweeper. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED` + a configured wallet
 * provider. Per-tick errors are swallowed so a transient provider /
 * Horizon / DB blip doesn't kill the interval.
 */
export function startWalletProvisioning(args?: { intervalMs?: number }): void {
  if (provisioningTimer !== null) return;
  const intervalMs = args?.intervalMs ?? WALLET_PROVISIONING_INTERVAL_MS;
  markWorkerStarted('wallet_provisioning', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting wallet-provisioning sweeper');
  const tick = async (): Promise<void> => {
    try {
      const r = await runWalletProvisioningTick();
      if (r.picked > 0) {
        log.info(r, 'Wallet-provisioning tick complete');
      }
      markWorkerTickSuccess('wallet_provisioning');
    } catch (err) {
      markWorkerTickFailure('wallet_provisioning', err);
      log.error({ err }, 'Wallet-provisioning tick failed');
    }
  };
  void tick();
  provisioningTimer = setInterval(() => void tick(), intervalMs);
  provisioningTimer.unref();
}

export function stopWalletProvisioning(): void {
  if (provisioningTimer === null) return;
  clearInterval(provisioningTimer);
  provisioningTimer = null;
  markWorkerStopped('wallet_provisioning');
  log.info('Wallet-provisioning sweeper stopped');
}
