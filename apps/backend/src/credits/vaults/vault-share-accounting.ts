/**
 * Off-chain share-accounting sums for the vault observability layer
 * (ADR 031 §D4/D8, V5). Pure DB reads over `vault_emissions` /
 * `vault_redemptions` / `vault_hot_float` — no Soroban I/O, no
 * `vaultsEnabled()` gate (callers already sit behind their own gate;
 * these are just SELECTs and are harmless to run against an empty
 * table set).
 *
 * Shared by `vault-drift-watcher.ts` (INV-V1 share-count drift + INV-V2
 * mirror-liability solvency) and `treasury/hot-float-reconciliation.ts`
 * (the float/pool desync check, comparing the operator's actual
 * on-chain share balance against what the emission/redemption
 * bookkeeping says it SHOULD be holding in-flight).
 *
 * ── Where every operator-minted share sits ─────────────────────────
 * At any instant a vault share is in exactly one of these buckets.
 * Getting this enumeration COMPLETE is load-bearing: an omitted
 * operator-held bucket makes the reconciliation's `expected` too low,
 * `actual` looks too high, and that positive phantom can numerically
 * OFFSET (and thus mask) a real double-withdraw shortfall — the exact
 * fund-drift the reconciler exists to catch (money-review V5 P1).
 *
 *   (1) HELD BY USERS — {@link sumOffChainNetUserShares}: emissions
 *       whose operator→user transfer landed (`transfer_tx_hash IS NOT
 *       NULL`) MINUS redemptions whose user→operator collect landed
 *       (`collect_tx_hash IS NOT NULL`). This is INV-V1's off-chain
 *       side, compared against on-chain `totalSupply - operatorBalance`.
 *
 *   Operator-held (the reconciliation's `expectedOperatorShares`):
 *   (2) EMISSION, deposited-not-transferred — {@link
 *       sumOperatorHeldEmissionShares}: `state='deposited'`
 *       (mid-emission) PLUS terminally-`failed` rows whose deposit
 *       landed but transfer never did (`deposit_tx_hash IS NOT NULL
 *       AND transfer_tx_hash IS NULL`) — the operator holds those
 *       minted shares indefinitely until an operator re-drives/refunds.
 *   (3) REDEMPTION, collected-not-yet-withdrawn — {@link
 *       sumOperatorHeldCollectedRedemptionShares}: `collect_tx_hash IS
 *       NOT NULL AND payout_path IS NULL AND state IN
 *       ('collecting','failed')` — the user's shares are with the
 *       operator but no payout path has run yet (so they are NOT in
 *       the hot-float pending count, and — slow path — NOT yet
 *       burned). `payout_path IS NULL` is the load-bearing
 *       discriminator that keeps this DISJOINT from bucket (4): once a
 *       fast-path draw sets `payout_path='fast'` the shares move into
 *       (4); once a slow-path `payout_path='slow'` withdraw lands they
 *       are burned (in neither bucket).
 *   (4) REDEMPTION, fast-path collected awaiting batch withdraw —
 *       `vault_hot_float.pending_unredeemed_shares`
 *       (`treasury/hot-float.ts`), read by callers via `getHotFloatRow`.
 *
 * So `onChainOperatorShareBalance ≈ (2)+(3)+(4)` and
 * `totalSupply - onChainOperatorShareBalance ≈ (1)`.
 *
 * ── Why INV-V2 uses mirror liability, NOT on-chain share value ─────
 * A tempting solvency check — `userShares × sharePrice` vs
 * `totalManaged` — is TAUTOLOGICALLY DEAD: `sharePrice` is itself
 * `totalManaged / totalSupply` (`vault-client.ts`'s `readVaultState`),
 * so `userShares × sharePrice = userShares × totalManaged/totalSupply
 * ≤ totalManaged` for any `userShares ≤ totalSupply` — the breach term
 * can never be positive (money-review V5 P0). The MEANINGFUL solvency
 * check compares the vault's own off-chain USD liability — {@link
 * sumVaultMirrorLiabilityMinor}, the fixed-USD cashback we credited
 * MINUS what we've debited on redemption, INDEPENDENT of the vault's
 * self-reported state — against the realizable backing (`totalManaged`
 * + hot float). A genuine Blend/DeFindex strategy impairment drops
 * `totalManaged` below that fixed liability and fires. Cleanly
 * vault-attributable (uses `vault_emissions`/`vault_redemptions` only),
 * so no classic-USDLOOP mirror contamination.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  vaultEmissions,
  vaultRedemptions,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
} from '../../db/schema.js';

/**
 * `SUM(...)::bigint` over postgres-js comes back as a JS `string`
 * (int8/numeric aggregates aren't auto-parsed to `bigint` the way a
 * drizzle-mapped `bigint('col', {mode:'bigint'})` COLUMN read is —
 * this is a raw `sql\`...\`` expression, not a mapped column, so it
 * goes through the driver's default decode path). Coerce explicitly
 * rather than trusting the (misleading) `sql<bigint | null>` TS
 * generic — caught by `__tests__/integration/vault-share-accounting.test.ts`
 * (real postgres; the mocked unit suites for the two V5 watchers stub
 * these functions entirely and would never have caught a string vs
 * bigint mismatch).
 */
async function sumBigint(
  query: Promise<Array<{ total: string | bigint | null }>>,
): Promise<bigint> {
  const rows = await query;
  const total = rows[0]?.total;
  if (total === null || total === undefined) return 0n;
  return typeof total === 'bigint' ? total : BigInt(total);
}

/**
 * Σ `vault_emissions.shares_minted` for rows whose operator→user
 * transfer has landed (`transfer_tx_hash IS NOT NULL`) — every share
 * ever handed to a user via the emission path, regardless of whether
 * the row has since advanced to `mirrored` (the mirror step never
 * touches share custody, only the off-chain liability, so it's
 * irrelevant to a share-count sum).
 */
export async function sumEmittedTransferredShares(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  return sumBigint(
    db
      .select({ total: sql<string | null>`SUM(${vaultEmissions.sharesMinted})::bigint` })
      .from(vaultEmissions)
      .where(
        and(
          eq(vaultEmissions.assetCode, assetCode),
          eq(vaultEmissions.network, network),
          isNotNull(vaultEmissions.transferTxHash),
        ),
      ),
  );
}

/**
 * Σ `vault_redemptions.shares_to_redeem` for rows whose user→operator
 * collect has landed (`collect_tx_hash IS NOT NULL`) — every share a
 * user has ever sent back via the redemption path, regardless of
 * whether the row has since advanced past `collecting` (payout /
 * mirror steps move value, not share custody).
 */
export async function sumRedeemedCollectedShares(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  return sumBigint(
    db
      .select({ total: sql<string | null>`SUM(${vaultRedemptions.sharesToRedeem})::bigint` })
      .from(vaultRedemptions)
      .where(
        and(
          eq(vaultRedemptions.assetCode, assetCode),
          eq(vaultRedemptions.network, network),
          isNotNull(vaultRedemptions.collectTxHash),
        ),
      ),
  );
}

/**
 * `sumEmittedTransferredShares - sumRedeemedCollectedShares` — the
 * off-chain-tracked net shares users should currently hold. Compared
 * against the on-chain figure (`totalSupply - operatorShareBalance`)
 * by `vault-drift-watcher.ts` for INV-V1.
 */
export async function sumOffChainNetUserShares(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  const [transferred, collected] = await Promise.all([
    sumEmittedTransferredShares(assetCode, network),
    sumRedeemedCollectedShares(assetCode, network),
  ]);
  return transferred - collected;
}

/**
 * Bucket (2) — Σ `vault_emissions.shares_minted` for shares the
 * operator legitimately holds on the EMISSION side: rows in state
 * `'deposited'` (mid-emission, minted but not yet transferred) PLUS
 * terminally-`failed` rows whose deposit landed but transfer never did
 * (`deposit_tx_hash IS NOT NULL AND transfer_tx_hash IS NULL`) — the
 * operator holds those minted shares until an operator re-drives or
 * refunds the stranded emission. Used by
 * `treasury/hot-float-reconciliation.ts`'s desync check.
 *
 * A `failed` row WITH `transfer_tx_hash` set is deliberately EXCLUDED:
 * the transfer was attempted (CF-18 persists the hash before submit),
 * so whether the operator still holds those shares is genuinely
 * ambiguous from the DB alone — counting it risks a false "operator
 * should hold more" if the transfer actually landed. Such a row is
 * rare (a terminal failure after a transfer submit) and pages via the
 * emission failure notifier anyway; leaving it out biases the desync
 * check toward the safe direction (it won't manufacture a phantom
 * positive that could mask a real shortfall).
 */
export async function sumOperatorHeldEmissionShares(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  return sumBigint(
    db
      .select({ total: sql<string | null>`SUM(${vaultEmissions.sharesMinted})::bigint` })
      .from(vaultEmissions)
      .where(
        and(
          eq(vaultEmissions.assetCode, assetCode),
          eq(vaultEmissions.network, network),
          sql`(
            ${vaultEmissions.state} = 'deposited'
            OR (
              ${vaultEmissions.state} = 'failed'
              AND ${vaultEmissions.depositTxHash} IS NOT NULL
              AND ${vaultEmissions.transferTxHash} IS NULL
            )
          )`,
        ),
      ),
  );
}

/**
 * Bucket (3) — Σ `vault_redemptions.shares_to_redeem` for shares the
 * operator holds from a REDEMPTION collect that has NOT yet run any
 * payout: `collect_tx_hash IS NOT NULL AND payout_path IS NULL AND
 * state IN ('collecting','failed')`. `payout_path IS NULL` is the
 * load-bearing discriminator that keeps this DISJOINT from the
 * hot-float pending count (bucket 4) and from burned slow-path shares:
 * a fast-path draw sets `payout_path='fast'` and moves the shares into
 * `vault_hot_float.pending_unredeemed_shares`; a slow-path
 * `payout_path='slow'` withdraw burns them. Only a collected row that
 * has done NEITHER still sits with the operator here — including a
 * terminally-`failed`-pre-payout row (collected, never paid, awaiting
 * a manual refund, per `markRedemptionNeedsRefund`). Used by
 * `treasury/hot-float-reconciliation.ts`'s desync check.
 */
export async function sumOperatorHeldCollectedRedemptionShares(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  return sumBigint(
    db
      .select({ total: sql<string | null>`SUM(${vaultRedemptions.sharesToRedeem})::bigint` })
      .from(vaultRedemptions)
      .where(
        and(
          eq(vaultRedemptions.assetCode, assetCode),
          eq(vaultRedemptions.network, network),
          isNotNull(vaultRedemptions.collectTxHash),
          sql`${vaultRedemptions.payoutPath} IS NULL`,
          sql`${vaultRedemptions.state} IN ('collecting', 'failed')`,
        ),
      ),
  );
}

/**
 * INV-V2 numerator — the vault path's OWN net off-chain USD liability,
 * in the vault currency's minor units: Σ `cashback_minor` for
 * emissions that reached `state='mirrored'` (credited `user_credits`)
 * MINUS Σ `value_minor` for redemptions that reached `state='settled'`
 * (debited `user_credits`). This is the fixed-USD amount we OWE vault
 * users, INDEPENDENT of the vault's self-reported `totalManaged` /
 * `sharePrice` — which is exactly what makes the solvency check
 * non-tautological (see the module header). Scoped to
 * `vault_emissions`/`vault_redemptions` only, so it carries no classic
 * USDLOOP mirror contamination even though both share the USD
 * `user_credits` currency.
 */
export async function sumVaultMirrorLiabilityMinor(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<bigint> {
  const [emitted, redeemed] = await Promise.all([
    sumBigint(
      db
        .select({ total: sql<string | null>`SUM(${vaultEmissions.cashbackMinor})::bigint` })
        .from(vaultEmissions)
        .where(
          and(
            eq(vaultEmissions.assetCode, assetCode),
            eq(vaultEmissions.network, network),
            eq(vaultEmissions.state, 'mirrored'),
          ),
        ),
    ),
    sumBigint(
      db
        .select({ total: sql<string | null>`SUM(${vaultRedemptions.valueMinor})::bigint` })
        .from(vaultRedemptions)
        .where(
          and(
            eq(vaultRedemptions.assetCode, assetCode),
            eq(vaultRedemptions.network, network),
            eq(vaultRedemptions.state, 'settled'),
          ),
        ),
    ),
  ]);
  return emitted - redeemed;
}
