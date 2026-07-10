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
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
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

const log = logger.child({ handler: 'redeem-vault' });

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

  const assetCode = vaultAssetForCurrency(order.chargeCurrency);
  const network = currentVaultNetwork();

  let row;
  try {
    row = await claimVaultRedemption({
      sourceType: 'order_redeem',
      sourceId: order.id,
      userId,
      assetCode,
      network,
      valueMinor: order.chargeMinor,
      fromAddress: user.walletAddress,
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
}
