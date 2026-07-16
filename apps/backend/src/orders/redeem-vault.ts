/**
 * ADR 031 §D6 (V4) — the vault-share fork of the `loop_asset` gift-
 * card redemption path. `orders/redeem.ts`'s `redeemLoopOrderHandler`
 * calls into this INSTEAD of building the classic on-chain LOOP-asset
 * payment when the order's `chargeCurrency` is vault-eligible (USD/EUR)
 * and `LOOP_VAULTS_ENABLED` is on — see that module's fork point.
 *
 * Unlike the classic path (a Horizon payment the payment watcher
 * matches asynchronously), this claims + drives a
 * `credits/vaults/vault-redemptions.ts` state-machine row directly:
 * the vault-share transfer targets the operator's account via a
 * Soroban contract invocation, which the classic payment-stream
 * watcher never observes, so this module — not the watcher — is what
 * eventually flips the order to `paid`.
 * `driveVaultRedemptionToCompletion` makes a bounded best-effort
 * attempt to settle inline (so a FAST/hot-float redemption can
 * complete within this HTTP request); the background sweep
 * (`vault-redemptions.ts`) is the eventual-completion guarantee
 * regardless of how far this call gets — a caller that gets back a
 * still-`pending_payment` order state should poll
 * `GET /api/orders/loop/:id` the same way it already does for the
 * classic on-chain-payment path.
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withAdvisoryLock } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { getUserById } from '../db/users.js';
import {
  claimVaultRedemption,
  driveVaultRedemptionToCompletion,
  vaultAssetForCurrency,
  currentVaultNetwork,
  isVaultEligibleCurrency,
} from '../credits/vaults/vault-redemptions.js';
import type { Order } from './repo.js';
import { guardAccountNotFrozen } from '../fraud/account-freeze-http.js';

const log = logger.child({ handler: 'redeem-vault' });

/**
 * Request-level in-flight fence (money-review P1-B), the same two-belt
 * shape the classic `orders/redeem.ts` path uses: an in-process Set
 * (same-machine double-tap; survives a pooled DATABASE_URL where the
 * advisory lock degrades to a no-op) plus a fleet-wide advisory lock
 * keyed by order id (cross-machine). This is defence-in-depth ON TOP of
 * the per-step collect CAS in `vault-redemptions.ts` (which is the
 * durable correctness guarantee): it just stops two concurrent taps
 * from each doing redundant claim+drive work and returns a clean
 * PAYMENT_IN_FLIGHT to the loser.
 */
const inFlightOrders = new Set<string>();

/** Test seam. */
export function __resetVaultRedeemFenceForTests(): void {
  inFlightOrders.clear();
}

function vaultRedeemFenceLockKey(orderId: string): bigint {
  const digest = createHash('sha256').update(`loop:vault-redeem:${orderId}`).digest();
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

export async function redeemLoopOrderViaVault(
  c: Context,
  order: Order,
  userId: string,
): Promise<Response> {
  if (!isVaultEligibleCurrency(order.chargeCurrency)) {
    // Unreachable in practice — the caller only forks here after this
    // exact check. Defence-in-depth: fail closed rather than claim a
    // row for an asset code the vault subsystem doesn't know.
    log.error(
      { orderId: order.id, chargeCurrency: order.chargeCurrency },
      'redeemLoopOrderViaVault called for a non-vault-eligible currency',
    );
    return c.json(
      { code: 'INTERNAL_ERROR', message: 'Invalid order currency for vault redemption' },
      500,
    );
  }

  const user = await getUserById(userId);
  if (
    user === null ||
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

  // NS-08 (design §5A #3): per-account freeze / AML-hold gate. The vault
  // fork collects the user's shares to the operator (money OUT) — ANY
  // live hold blocks it. Belt-and-suspenders with the entry gate in
  // `redeem.ts` (§5A #2, before the fork); this covers a direct/future
  // caller and keeps the fork self-guarding. BEFORE the fence +
  // `claimVaultRedemption` so no row is claimed for a frozen account.
  const frozen = await guardAccountNotFrozen(c, userId, 'user_withdrawal');
  if (frozen !== null) {
    log.warn({ orderId: order.id, userId }, 'Vault redemption refused — account frozen (NS-08)');
    return frozen;
  }

  const assetCode = vaultAssetForCurrency(order.chargeCurrency);
  const network = currentVaultNetwork();
  const walletAddress = user.walletAddress;

  // Request-level in-flight fence (P1-B) — in-process Set first (same-
  // machine, survives a degraded advisory lock), then the fleet-wide
  // advisory lock.
  if (inFlightOrders.has(order.id)) {
    return c.json(
      { code: 'PAYMENT_IN_FLIGHT', message: 'A payment for this order is already in flight' },
      400,
    );
  }
  inFlightOrders.add(order.id);
  let fenced;
  try {
    fenced = await withAdvisoryLock(vaultRedeemFenceLockKey(order.id), async () => {
      let row;
      try {
        row = await claimVaultRedemption({
          sourceType: 'order_redeem',
          sourceId: order.id,
          userId,
          assetCode,
          network,
          valueMinor: order.chargeMinor,
          fromAddress: walletAddress,
        });
      } catch (err) {
        log.error({ err, orderId: order.id }, 'vault redemption claim failed');
        return c.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'Redemption temporarily unavailable' },
          503,
        );
      }

      const settled = await driveVaultRedemptionToCompletion(row);

      if (settled.state === 'failed') {
        // Terminal, not auto-retried (module header, mirrors V3's same
        // known gap) — the order stays `pending_payment`; ops must
        // reconcile via the row's `last_error` (paged to Discord already
        // by `recordStepFailure`). No admin re-drive endpoint ships in V4.
        log.error(
          { orderId: order.id, vaultRedemptionId: settled.id },
          'vault redemption reached terminal failed state',
        );
        return c.json(
          {
            code: 'INTERNAL_ERROR',
            message: 'Redemption could not be completed — please contact support',
          },
          500,
        );
      }

      const fresh = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
      return c.json({ state: fresh?.state ?? order.state });
    });
  } finally {
    inFlightOrders.delete(order.id);
  }
  if (!fenced.ran) {
    return c.json(
      { code: 'PAYMENT_IN_FLIGHT', message: 'A payment for this order is already in flight' },
      400,
    );
  }
  return fenced.value;
}
