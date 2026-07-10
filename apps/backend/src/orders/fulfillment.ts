/**
 * Order fulfillment transition (ADR 009 / 010 / 015).
 *
 * Lifted out of `./transitions.ts` so the cashback-capture +
 * payout-intent write doesn't share a file with the simple
 * state-only transitions (paid / procuring / failed). Fulfillment
 * is the one transition that fans out to four tables in a single
 * Drizzle transaction:
 *
 *   1. `orders`           — state → fulfilled, gift-card redemption fields
 *   2. `credit_transactions` — append cashback row (ADR 009)
 *   3. `user_credits`     — bump per-currency balance
 *   4. `pending_payouts`  — Stellar-side emission intent (ADR 015)
 *
 * Co-locating the ladder here keeps the multi-table semantics
 * (cashback capture co-fires with the on-chain payout intent inside
 * one txn — no orphaned payouts without a matching ledger row, no
 * ledger rows the payout worker never sees) readable as one slice.
 *
 * Re-exported from `./transitions.ts` so existing import sites
 * (`procurement.ts`, the admin compensation handler, the test
 * suite) keep resolving.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, creditTransactions, userCredits, users, pendingPayouts } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { isHomeCurrency } from '@loop/shared';
import { buildPayoutIntent } from '../credits/payout-builder.js';
import { notifyPegBreakOnFulfillment } from '../discord.js';
import { encryptRedeemField } from './redeem-crypto.js';
import type { Order } from './repo.js';
import { vaultsEnabled, getActiveVault } from '../credits/vaults/registry.js';
import {
  claimVaultEmission,
  vaultAssetForCurrency,
  currentVaultNetwork,
  isVaultEligibleCurrency,
} from '../credits/vaults/vault-emissions.js';

const log = logger.child({ area: 'order-transitions' });

export interface RedemptionPayload {
  code?: string | null;
  pin?: string | null;
  url?: string | null;
}

/**
 * Transition: `procuring` → `fulfilled`. Writes the cashback ledger
 * entries in the same txn (ADR 009 capture):
 *
 *   1. Update the order row: state, ctx_order_id, fulfilled_at.
 *   2. Insert a `credit_transactions` row (type='cashback',
 *      amount=+user_cashback_minor, reference_type='order',
 *      reference_id=<order-id>).
 *   3. Upsert the user's `user_credits` row for the order's currency,
 *      adding `user_cashback_minor` to the running balance.
 *
 * Returns the fulfilled order or null if the state wasn't `procuring`
 * (which makes the caller treat it as already-fulfilled + a no-op).
 * Zero-cashback orders still transition cleanly — the capture block
 * skips the ledger writes but the order still moves to `fulfilled`.
 */
export async function markOrderFulfilled(
  orderId: string,
  opts: { ctxOrderId: string; redemption?: RedemptionPayload },
): Promise<Order | null> {
  // A4-023 peg-break alert payload, captured inside the transaction
  // but emitted only after it commits — firing the Discord notify
  // from within the txn callback meant a rollback (e.g. a failed
  // pending_payouts insert) still alerted ops about ledger writes
  // that never landed.
  type PegBreakAlert = Parameters<typeof notifyPegBreakOnFulfillment>[0];
  const txnResult = await db.transaction<{
    order: Order;
    pegBreak: PegBreakAlert | null;
    // CF-16: whether the durable peg-break pending_payouts row was
    // written inside the txn (drives the post-commit log only).
    pegBreakDurableRow: boolean;
  } | null>(async (tx) => {
    let pegBreak: PegBreakAlert | null = null;
    let pegBreakDurableRow = false;
    const updated = await tx
      .update(orders)
      .set({
        state: 'fulfilled',
        ctxOrderId: opts.ctxOrderId,
        fulfilledAt: new Date(),
        // CF-25 / X-PRIV-03: code + PIN are spendable bearer secrets —
        // envelope-encrypt them at rest. `redeem_url` is the redemption
        // landing page, not the secret, so it stays plaintext. Encryption
        // is a no-op passthrough when LOOP_REDEEM_ENCRYPTION_KEY is unset.
        redeemCode: encryptRedeemField(opts.redemption?.code),
        redeemPin: encryptRedeemField(opts.redemption?.pin),
        redeemUrl: opts.redemption?.url ?? null,
      })
      .where(and(eq(orders.id, orderId), eq(orders.state, 'procuring')))
      .returning();
    const order = updated[0];
    if (order === undefined) return null;

    // Skip ledger writes when the pinned cashback amount is zero —
    // a cashback=0 row is not meaningful and would fail the
    // `credit_transactions_amount_sign` CHECK (which requires
    // cashback > 0).
    if (order.userCashbackMinor > 0n) {
      // Read the user row FIRST — used both by the ADR 031 V3
      // vault-eligibility fork below and by the classic payout-intent
      // branch further down. Pure SELECT, no side effects: moving it
      // ahead of the mirror-credit writes changes nothing about the
      // classic path's output. `vaultEligible` short-circuits on
      // `vaultsEnabled()` (default false) before any extra DB read,
      // so with the flag off this is byte-identical in behavior AND
      // query count to pre-V3.
      const [userRow] = await tx
        .select({
          stellarAddress: users.stellarAddress,
          homeCurrency: users.homeCurrency,
          walletAddress: users.walletAddress,
          walletProvisioning: users.walletProvisioning,
        })
        .from(users)
        .where(eq(users.id, order.userId));

      // ADR 031 §D5 (V3) — gated fork. The vault path REPLACES the
      // classic path's mirror-credit-then-payout for this order
      // entirely (it does its own mirror credit later, once shares
      // have actually landed in the user's wallet — see
      // `credits/vaults/vault-emissions.ts`'s header for why the
      // ordering differs from the classic path). Scope: happy-path
      // currency match only (no peg-break vault-forking — that rare
      // edge case stays on the well-tested classic path).
      let vaultClaimed = false;
      if (
        // P2-5 (money-review #1647): structural Phase-1 gate. The
        // vault cashback surface must be inert in Phase 1 by
        // CONSTRUCTION, not incidentally (Phase-1 orders already carry
        // userCashbackMinor=0 via orders/repo.ts, so this block is
        // reached with a >0 cashback only outside Phase 1 — but pin it
        // explicitly, mirroring the loop_asset spend gates in
        // orders/loop-handler.ts + orders/redeem.ts).
        !env.LOOP_PHASE_1_ONLY &&
        vaultsEnabled() &&
        userRow !== undefined &&
        isHomeCurrency(userRow.homeCurrency) &&
        order.chargeCurrency === userRow.homeCurrency &&
        isVaultEligibleCurrency(order.chargeCurrency) &&
        userRow.walletProvisioning === 'activated' &&
        userRow.walletAddress !== null
      ) {
        const vaultAssetCode = vaultAssetForCurrency(order.chargeCurrency);
        const vaultNetwork = currentVaultNetwork();
        const vault = await getActiveVault(vaultAssetCode, vaultNetwork);
        if (vault !== null) {
          // Fast, local claim only (no Soroban/network I/O) — see
          // `claimVaultEmission`'s doc comment. The actual deposit /
          // transfer / mirror is driven later by the vault-emission
          // sweep, exactly as the classic path's own
          // `pending_payouts` row is drained later by the separate
          // payout-submit worker rather than inline here.
          vaultClaimed = await claimVaultEmission(tx, {
            orderId: order.id,
            userId: order.userId,
            assetCode: vaultAssetCode,
            network: vaultNetwork,
            cashbackMinor: order.userCashbackMinor,
            toAddress: userRow.walletAddress,
          });
        }
      }

      if (!vaultClaimed) {
        // ADR 015 — write the ledger in the user's home currency
        // (charge_currency), not the catalog currency (currency).
        // For same-currency orders this is a no-op (they're equal);
        // for cross-FX orders this is the correct denomination since
        // user_cashback_minor is now computed from chargeMinor.
        await tx.insert(creditTransactions).values({
          userId: order.userId,
          type: 'cashback',
          amountMinor: order.userCashbackMinor,
          currency: order.chargeCurrency,
          referenceType: 'order',
          referenceId: order.id,
        });
        // Upsert the balance row: add cashback to existing, or create
        // a new per-currency row at the cashback amount. Concurrency-
        // safe via the unique index on (user_id, currency).
        await tx
          .insert(userCredits)
          .values({
            userId: order.userId,
            currency: order.chargeCurrency,
            balanceMinor: order.userCashbackMinor,
          })
          .onConflictDoUpdate({
            target: [userCredits.userId, userCredits.currency],
            set: {
              balanceMinor: sql`${userCredits.balanceMinor} + ${order.userCashbackMinor}`,
              updatedAt: sql`NOW()`,
            },
          });

        // ADR 015 — write a pending payout row for the Stellar-side
        // emission, if the user has a linked wallet + a configured
        // LOOP issuer for their home currency. The SDK submit worker
        // reads pending rows and signs + submits each one. Building
        // + inserting inside the same transaction as the ledger write
        // means a crash mid-fulfillment either records both or
        // neither — no orphaned payouts without a matching ledger
        // entry, no ledger entries the payout worker never sees.
        if (userRow !== undefined && isHomeCurrency(userRow.homeCurrency)) {
          // order.chargeCurrency pins the ledger currency. An audit
          // warning when it doesn't match the user's home currency —
          // shouldn't happen (loop-handler pins both to home currency
          // at order creation), but would indicate support-mediated
          // home-currency change after an order was placed.
          if (order.chargeCurrency !== userRow.homeCurrency) {
            // A4-023 peg break: the order's pinned chargeCurrency no
            // longer matches the user's home currency (support-mediated
            // home-currency change after the order was placed). The
            // off-chain cashback already wrote (above) in chargeCurrency.
            //
            // CF-16 (x-flows F2-1): build the matching on-chain payout in
            // the order's chargeCurrency — exactly what the peg-break
            // runbook prescribes ("issue the on-chain payout in the
            // order's chargeCurrency") — and write a DURABLE
            // pending_payouts row so the payout worker actually drives
            // the on-chain emission later. Previously this path only
            // emitted a Discord warn, so a missed alert meant a permanent
            // off-chain/on-chain divergence with nothing to reconcile it.
            //
            // The pending_payouts_order_unique index keeps this idempotent
            // against a re-run; the worker's trustline pre-check + issuer
            // gate handle the user-not-ready cases. We pass the order's
            // chargeCurrency (a LOOP home currency) as the asset selector
            // so buildPayoutIntent picks the chargeCurrency LOOP asset,
            // not the user's new home-currency asset.
            let durableRowWritten = false;
            if (isHomeCurrency(order.chargeCurrency)) {
              const decision = buildPayoutIntent({
                // ADR 030 Phase C2 — same activated-embedded-wallet
                // precedence as the happy path below; without this the
                // peg-break durable row silently fell back to the legacy
                // linked address (or `no_address` for embedded-wallet-
                // only users), reopening the exact off-chain/on-chain
                // divergence gap CF-16 closed, just scoped to users who
                // never linked a legacy address.
                embeddedWalletAddress:
                  userRow.walletProvisioning === 'activated' ? userRow.walletAddress : null,
                stellarAddress: userRow.stellarAddress,
                homeCurrency: order.chargeCurrency,
                userCashbackMinor: order.userCashbackMinor,
              });
              if (decision.kind === 'pay') {
                const inserted = await tx
                  .insert(pendingPayouts)
                  .values({
                    userId: order.userId,
                    orderId: order.id,
                    assetCode: decision.intent.assetCode,
                    assetIssuer: decision.intent.assetIssuer,
                    toAddress: decision.intent.to,
                    amountStroops: decision.intent.amountStroops,
                    memoText: decision.intent.memoText,
                  })
                  .onConflictDoNothing({
                    target: pendingPayouts.orderId,
                    // Partial unique index (migration 0038 / ADR 036) —
                    // the ON CONFLICT target must name the index
                    // predicate to match `pending_payouts_order_unique`.
                    where: sql`kind = 'order_cashback'`,
                  })
                  .returning({ id: pendingPayouts.id });
                durableRowWritten = inserted.length > 0;
              } else {
                // no_address / no_issuer / no_cashback — same skip
                // reasons as the happy path. The Discord alert below
                // still fires so ops can drive the on-chain side
                // manually once the user is ready (links a wallet, etc.).
                log.info(
                  { orderId: order.id, reason: decision.reason },
                  'CF-16: peg-break durable payout row skipped (builder skip reason); Discord alert still fires',
                );
              }
            } else {
              // chargeCurrency isn't a LOOP home currency — can't pin an
              // asset. Should not happen (charge currency is pinned to a
              // LOOP currency at order creation); alert-only fallback.
              log.error(
                { orderId: order.id, chargeCurrency: order.chargeCurrency },
                'CF-16: peg-break chargeCurrency is not a LOOP home currency — cannot build durable payout row',
              );
            }
            // Surface beyond a log line — emit a Discord alert so ops can
            // confirm the on-chain side. Capture the payload here; the
            // log + fire-and-forget notify happen after the transaction
            // resolves (see below) so a rollback can't alert on ledger
            // writes that never committed. A Discord blip never blocks
            // the order's transition.
            pegBreak = {
              orderId: order.id,
              userId: order.userId,
              chargeCurrency: order.chargeCurrency,
              userHomeCurrency: userRow.homeCurrency,
              cashbackMinor: order.userCashbackMinor.toString(),
            };
            pegBreakDurableRow = durableRowWritten;
          } else {
            const decision = buildPayoutIntent({
              // ADR 030 Phase C2 — activated embedded wallet wins over
              // the legacy linked address; a wallet that exists but is
              // not yet activated has no trustlines and must not be
              // targeted (the legacy address / skip path applies).
              embeddedWalletAddress:
                userRow.walletProvisioning === 'activated' ? userRow.walletAddress : null,
              stellarAddress: userRow.stellarAddress,
              homeCurrency: userRow.homeCurrency,
              userCashbackMinor: order.userCashbackMinor,
            });
            if (decision.kind === 'pay') {
              await tx
                .insert(pendingPayouts)
                .values({
                  userId: order.userId,
                  orderId: order.id,
                  assetCode: decision.intent.assetCode,
                  assetIssuer: decision.intent.assetIssuer,
                  toAddress: decision.intent.to,
                  amountStroops: decision.intent.amountStroops,
                  memoText: decision.intent.memoText,
                })
                .onConflictDoNothing({
                  target: pendingPayouts.orderId,
                  // Partial unique index (migration 0038 / ADR 036) —
                  // the ON CONFLICT target must name the index
                  // predicate to match `pending_payouts_order_unique`.
                  where: sql`kind = 'order_cashback'`,
                });
            } else {
              log.info(
                { orderId: order.id, reason: decision.reason },
                'Skipping on-chain cashback payout',
              );
            }
          }
        }
      } // closes `if (!vaultClaimed)` (ADR 031 V3 gated fork)
    }
    return { order, pegBreak, pegBreakDurableRow };
  });
  if (txnResult === null) return null;
  if (txnResult.pegBreak !== null) {
    log.warn(
      {
        orderId: txnResult.pegBreak.orderId,
        chargeCurrency: txnResult.pegBreak.chargeCurrency,
        userHomeCurrency: txnResult.pegBreak.userHomeCurrency,
        // CF-16: true → a durable pending_payouts row in chargeCurrency
        // was written, so the payout worker will drive the on-chain
        // emission (no longer alert-only). false → builder skip
        // (no wallet / no issuer) or non-LOOP chargeCurrency; ops drives
        // it manually per the runbook.
        durablePayoutRowWritten: txnResult.pegBreakDurableRow,
      },
      txnResult.pegBreakDurableRow
        ? 'A4-023/CF-16: order charge currency diverged from user home currency — durable on-chain payout row written in chargeCurrency, peg break Discord notification sent'
        : 'A4-023/CF-16: order charge currency diverged from user home currency — durable payout row NOT written (no wallet/issuer); peg break Discord notification sent',
    );
    notifyPegBreakOnFulfillment(txnResult.pegBreak);
  }
  return txnResult.order;
}
