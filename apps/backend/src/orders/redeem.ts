/**
 * One-tap redemption (ADR 030 Phase C3 / ADR 036). UI copy may still
 * say "pay with your Loop balance" — the balance IS the tokens — but
 * the engineering name for this surface is ADR 036's own term:
 * redemption (the user's LOOP returning to the system).
 *
 * `POST /api/orders/loop/:id/redeem` — the server-side
 * redemption orchestration: instead of the user manually sending
 * LOOP-asset to the deposit address from an external wallet, the
 * backend builds the payment FROM the user's embedded wallet,
 * collects the user's signature via the wallet provider (Phase-B
 * bridge), wraps it in an operator **fee-bump** (the user holds zero
 * XLM by design — every reserve is sponsored, and fees come from the
 * operator), and submits.
 *
 * Everything downstream is the EXISTING pipeline, on purpose: the
 * payment lands at the deposit address carrying the order's payment
 * memo, the payment watcher matches it, `markOrderPaid` debits the
 * mirror and enqueues the ADR-036 issuer-return burn, and the
 * skip-table catches any transient failure. This handler introduces
 * no new ledger semantics — it is a tx-assembly convenience.
 *
 * Transaction shape:
 *
 *   inner  (source: user wallet, fee: BASE_FEE, user-signed via rawSign)
 *     payment(user → deposit, <chargeCurrency's LOOP asset>, chargeMinor)
 *     memo: the order's payment memo
 *   outer  (fee-bump, feeSource: operator, operator-signed)
 *
 * Idempotency / fencing:
 *   - Order-state guard: only `pending_payment` orders build a tx.
 *     Already-paid states (`paid`/`procuring`/`fulfilled`) replay
 *     `{ state }` with 200 — a double-tap after the watcher caught
 *     the payment is success, not an error.
 *   - In-flight fence: an in-process per-order set rejects a
 *     concurrent second call (`400 PAYMENT_IN_FLIGHT`) so two taps
 *     can't double-submit two payments before the watcher flips the
 *     state. (Single-process deployment today — Fly runs one
 *     machine; a multi-instance future needs a DB-level fence.)
 *   - Even if a duplicate payment slips through (e.g. across a
 *     restart), the second deposit finds no `pending_payment` order
 *     for the memo and parks in the watcher's skip table for ops —
 *     funds are never silently lost.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Operation,
  Asset,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { isHomeCurrency } from '@loop/shared';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';
import { PayoutSubmitError, submitPreSignedTransaction } from '../payments/payout-submit.js';
import { getUserById } from '../db/users.js';
import { getWalletProvider } from '../wallet/provider.js';
import { WalletProviderError } from '../wallet/provider.js';
import { attachUserWalletSignature } from '../wallet/user-signer.js';

const log = logger.child({ handler: 'redeem' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LOOP assets are 1:1 with fiat minor units at 7 decimals (A4-029). */
const LOOP_ASSET_STROOPS_PER_MINOR = 100_000n;

/** Inner-tx timebound. One provider signing roundtrip fits comfortably. */
const PAY_TIMEOUT_SECONDS = 60;

/**
 * Order states that mean "the payment already landed" — a repeat
 * call replays `{ state }` instead of erroring (idempotent success).
 */
const ALREADY_PAID_STATES = new Set(['paid', 'procuring', 'fulfilled']);

/**
 * In-process per-order fence. Entries live only for the duration of
 * one handler invocation (try/finally) — this is a concurrency
 * fence, not a cache, so process restarts clearing it is correct.
 */
const inFlightOrders = new Set<string>();

/** Test seam. */
export function __resetRedeemFenceForTests(): void {
  inFlightOrders.clear();
}

/** `12_3400000n` stroops → `"12.3400000"` (SDK amount string). */
function stroopsToAmount(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

export interface BuildRedeemArgs {
  /** User wallet account (address + current sequence) — pre-loaded. */
  userAccount: Account;
  depositAddress: string;
  asset: { code: string; issuer: string };
  /** What the user owes, in stroops of the LOOP asset. */
  amountStroops: bigint;
  /** The order's payment memo — the watcher's matching key. */
  memoText: string;
  networkPassphrase: string;
  timeoutSeconds?: number;
}

/**
 * Builds (does NOT sign) the inner payment transaction. Pure given a
 * pre-loaded user `Account` so tests can pin the envelope — source,
 * single payment op, asset, amount, memo — without Horizon.
 *
 * Inner fee is BASE_FEE: the outer fee-bump pays the real fee, but
 * Horizon requires the inner bid to be a valid fee field; BASE_FEE
 * keeps the envelope well-formed under every SDK validation path.
 */
export function buildRedeemTransaction(args: BuildRedeemArgs): Transaction {
  return new TransactionBuilder(args.userAccount, {
    fee: BASE_FEE,
    networkPassphrase: args.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: args.depositAddress,
        asset: new Asset(args.asset.code, args.asset.issuer),
        amount: stroopsToAmount(args.amountStroops),
      }),
    )
    .addMemo(Memo.text(args.memoText))
    .setTimeout(args.timeoutSeconds ?? PAY_TIMEOUT_SECONDS)
    .build();
}

/**
 * Outer fee-bump base fee (per operation, stroops). Must be ≥ both
 * the network minimum and the inner tx's fee rate (CAP-15); doubling
 * the configured A2-1921 base clears both with margin while staying
 * within the configured cap.
 */
export function feeBumpBaseFee(): string {
  const doubled = env.LOOP_PAYOUT_FEE_BASE_STROOPS * 2;
  const capped = Math.min(Math.max(doubled, 2 * Number(BASE_FEE)), env.LOOP_PAYOUT_FEE_CAP_STROOPS);
  return String(Math.floor(capped));
}

export async function redeemLoopOrderHandler(c: Context): Promise<Response> {
  if (!env.LOOP_AUTH_NATIVE_ENABLED) {
    // Mirror the loop-order handlers' 404 policy while the flag is off.
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json(
      { code: 'UNAUTHORIZED', message: 'Loop-native authentication required for this endpoint' },
      401,
    );
  }
  const orderId = c.req.param('id');
  if (orderId === undefined || !UUID_RE.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id must be an order uuid' }, 400);
  }

  // Owner-scoped read; 404 on non-owner so order ids aren't enumerable.
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.userId, auth.userId)),
  });
  if (order === undefined || order === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }

  // Idempotent replay: the payment already landed (or this is a
  // double-tap racing the watcher) — success, return the state.
  if (ALREADY_PAID_STATES.has(order.state)) {
    return c.json({ state: order.state });
  }
  if (order.state !== 'pending_payment' || order.paymentMethod !== 'loop_asset') {
    return c.json(
      {
        code: 'ORDER_NOT_PAYABLE',
        message:
          order.paymentMethod !== 'loop_asset'
            ? 'Order was not created with the loop_asset payment method'
            : `Order is ${order.state} and can no longer be paid`,
      },
      400,
    );
  }
  if (order.paymentMemo === null) {
    // loop_asset orders always carry a memo (repo.ts) — a null here
    // is schema drift / hand-edited row. Fail loud.
    log.error({ orderId }, 'loop_asset order has no payment memo');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Order is missing its payment memo' }, 500);
  }

  const provider = getWalletProvider();
  if (provider === null) {
    return c.json(
      { code: 'NOT_CONFIGURED', message: 'Embedded wallet is not enabled on this deployment' },
      503,
    );
  }
  if (env.LOOP_STELLAR_DEPOSIT_ADDRESS === undefined) {
    log.error('LOOP_STELLAR_DEPOSIT_ADDRESS unset — refusing redemption');
    return c.json(
      { code: 'SERVICE_UNAVAILABLE', message: 'On-chain payment temporarily unavailable' },
      503,
    );
  }
  const operatorSecret = env.LOOP_STELLAR_OPERATOR_SECRET;
  if (operatorSecret === undefined) {
    return c.json(
      { code: 'NOT_CONFIGURED', message: 'Operator fee account is not configured' },
      503,
    );
  }
  if (!isHomeCurrency(order.chargeCurrency)) {
    log.error({ orderId, chargeCurrency: order.chargeCurrency }, 'Unsupported charge currency');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Invalid order currency' }, 500);
  }
  const asset = payoutAssetFor(order.chargeCurrency);
  if (asset.issuer === null) {
    return c.json(
      {
        code: 'NOT_CONFIGURED',
        message: `LOOP asset for ${order.chargeCurrency} is not configured`,
      },
      503,
    );
  }

  const user = await getUserById(auth.userId);
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'User record not found' }, 401);
  }
  if (
    user.walletProvisioning !== 'activated' ||
    user.walletId === null ||
    user.walletAddress === null
  ) {
    return c.json(
      {
        code: 'WALLET_NOT_ACTIVATED',
        message: 'Your Loop wallet is still being set up — try again shortly',
      },
      400,
    );
  }
  const { walletId, walletAddress } = user;

  // In-flight fence — one build/sign/submit per order at a time.
  if (inFlightOrders.has(orderId)) {
    return c.json(
      { code: 'PAYMENT_IN_FLIGHT', message: 'A payment for this order is already in flight' },
      400,
    );
  }
  inFlightOrders.add(orderId);
  try {
    const requiredStroops = order.chargeMinor * LOOP_ASSET_STROOPS_PER_MINOR;

    // Early balance check for honest UX. The authoritative check is
    // still the watcher's (and ultimately Horizon's op_underfunded).
    let snapshot;
    try {
      snapshot = await getAccountTrustlines(walletAddress);
    } catch (err) {
      log.warn({ err, orderId }, 'Horizon balance read failed during redeem');
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Balance check temporarily unavailable' },
        503,
      );
    }
    const line = snapshot.trustlines.get(`${asset.code}::${asset.issuer}`);
    if (!snapshot.accountExists || line === undefined || line.balanceStroops < requiredStroops) {
      return c.json(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: `Your on-chain ${asset.code} balance does not cover this order`,
        },
        400,
      );
    }

    // Build inner tx with a fresh user-account sequence.
    const server = new Horizon.Server(env.LOOP_STELLAR_HORIZON_URL);
    let userAccount: Account;
    try {
      const loaded = await server.loadAccount(walletAddress);
      userAccount = new Account(walletAddress, loaded.sequenceNumber());
    } catch (err) {
      log.warn({ err, orderId }, 'Horizon loadAccount failed during redeem');
      return c.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Stellar temporarily unavailable' },
        503,
      );
    }
    const innerTx = buildRedeemTransaction({
      userAccount,
      depositAddress: env.LOOP_STELLAR_DEPOSIT_ADDRESS,
      asset: { code: asset.code, issuer: asset.issuer },
      amountStroops: requiredStroops,
      memoText: order.paymentMemo,
      networkPassphrase: env.LOOP_STELLAR_NETWORK_PASSPHRASE,
    });

    // User signs the inner tx (provider rawSign, locally verified)...
    try {
      await attachUserWalletSignature({ provider, walletId, address: walletAddress, tx: innerTx });
    } catch (err) {
      if (err instanceof WalletProviderError && err.kind === 'transient_provider') {
        log.warn({ err: err.message, orderId }, 'Wallet provider transient failure on rawSign');
        return c.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'Wallet signing temporarily unavailable' },
          503,
        );
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err), orderId },
        'Wallet provider terminal failure on rawSign',
      );
      return c.json({ code: 'INTERNAL_ERROR', message: 'Wallet signing failed' }, 500);
    }

    // ...the operator fee-bumps + signs the outer envelope (the user
    // holds zero XLM — sponsored reserves, operator-paid fees).
    const operatorKeypair = Keypair.fromSecret(operatorSecret);
    const feeBump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
      operatorKeypair,
      feeBumpBaseFee(),
      innerTx,
      env.LOOP_STELLAR_NETWORK_PASSPHRASE,
    );
    feeBump.sign(operatorKeypair);

    try {
      const result = await submitPreSignedTransaction({
        horizonUrl: env.LOOP_STELLAR_HORIZON_URL,
        tx: feeBump,
      });
      log.info(
        { orderId, txHash: result.txHash, asset: asset.code },
        'Pay-with-balance payment submitted — watcher will match the memo',
      );
    } catch (err) {
      if (err instanceof PayoutSubmitError) {
        if (err.kind === 'terminal_underfunded') {
          // Balance raced away between the pre-check and the submit.
          return c.json(
            {
              code: 'INSUFFICIENT_BALANCE',
              message: `Your on-chain ${asset.code} balance does not cover this order`,
            },
            400,
          );
        }
        if (err.kind === 'transient_horizon' || err.kind === 'transient_rebuild') {
          log.warn({ err: err.message, orderId }, 'Transient Horizon failure on redeem');
          return c.json(
            { code: 'SERVICE_UNAVAILABLE', message: 'Stellar temporarily unavailable' },
            503,
          );
        }
        log.error(
          { err: err.message, kind: err.kind, resultCodes: err.resultCodes, orderId },
          'Terminal submit failure on redeem',
        );
        return c.json({ code: 'INTERNAL_ERROR', message: 'Payment submission failed' }, 500);
      }
      throw err;
    }

    // Submitted. The order flips pending_payment → paid when the
    // watcher matches the memo (typically the next tick); re-read so
    // a fast watcher is reflected immediately.
    const fresh = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    return c.json({ state: fresh?.state ?? order.state });
  } finally {
    inFlightOrders.delete(orderId);
  }
}
