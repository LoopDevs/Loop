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
 * ── "Landed" means the CONFIRMED-landed timestamp, not the tx hash ──
 * CF-18 persists a step's `*_tx_hash` in `onSigned` — BEFORE the
 * network submit — so `transfer_tx_hash`/`collect_tx_hash IS NOT NULL`
 * means "submitted, maybe not landed", NOT "landed" (INV-V3 spells
 * this out: "a persisted `collect_tx_hash` is NOT proof of landing").
 * Every predicate below therefore keys the user-holds / operator-holds
 * split on the CONFIRMED-landed marker — the `transferred_at` /
 * `collected_at` timestamp, set only AFTER the on-chain step confirms
 * (`vault-emissions.ts:422` / `vault-redemptions.ts:478`), the same
 * marker `vault-redemptions.ts` itself gates payout on — never the
 * pre-submit hash (money-review V5, both reviewers). Using the hash
 * would (a) count a submitted-but-unconfirmed transfer as user-held →
 * transient false drift, and (b) — the dangerous one — EXCLUDE a
 * terminal-`failed` emission whose transfer didn't land from the
 * operator-held bucket, a standing positive phantom that could mask a
 * real double-withdraw shortfall.
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
 *       whose operator→user transfer CONFIRMED landed (`transferred_at
 *       IS NOT NULL`) MINUS redemptions whose user→operator collect
 *       CONFIRMED landed (`collected_at IS NOT NULL`). This is INV-V1's
 *       off-chain side, compared against on-chain `totalSupply -
 *       operatorBalance`.
 *
 *   Operator-held (the reconciliation's `expectedOperatorShares`):
 *   (2) EMISSION, minted-but-not-transferred-to-user — {@link
 *       sumOperatorHeldEmissionShares}: `shares_minted IS NOT NULL AND
 *       transferred_at IS NULL AND state IN ('deposited','failed')`.
 *       `state='deposited'` is the mid-emission case; a terminal
 *       `failed` row with `shares_minted` set but `transferred_at`
 *       NULL means the deposit landed (operator got the shares) but
 *       the transfer never CONFIRMED — so the operator STILL HOLDS
 *       them until an operator re-drives/refunds. **These `failed`
 *       shares MUST be counted** (money-review V5): excluding them was
 *       a standing positive phantom that could mask a real shortfall.
 *       A `failed` row WITH `transferred_at` set (transfer landed,
 *       then a later step failed) is correctly EXCLUDED — the user
 *       holds those, and bucket (1) counts them.
 *   (3) REDEMPTION, collected-not-yet-paid-out — {@link
 *       sumOperatorHeldCollectedRedemptionShares}: `collected_at IS NOT
 *       NULL AND payout_path IS NULL AND state IN
 *       ('collecting','failed')` — the collect CONFIRMED landed (shares
 *       with the operator) but no payout path has run yet (so they are
 *       NOT in the hot-float pending count, and — slow path — NOT yet
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
 * transfer has CONFIRMED landed (`transferred_at IS NOT NULL` — set
 * only at the `transferred` transition, `vault-emissions.ts:422`) —
 * every share actually handed to a user, regardless of whether the row
 * has since advanced to `mirrored` OR later went `failed` at the mirror
 * step (the mirror step moves off-chain liability, not share custody,
 * so a failed-post-transfer row's shares are still with the user).
 * Deliberately NOT `transfer_tx_hash IS NOT NULL`, which is set
 * pre-submit (CF-18) and would count a submitted-but-unconfirmed
 * transfer as user-held (money-review V5).
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
          isNotNull(vaultEmissions.transferredAt),
        ),
      ),
  );
}

/**
 * Σ `vault_redemptions.shares_to_redeem` for rows whose user→operator
 * collect has CONFIRMED landed (`collected_at IS NOT NULL` — set only
 * after the collect transfer confirms, `vault-redemptions.ts:478`, the
 * same marker the redemption code itself gates payout on) — every
 * share a user has actually sent back, regardless of downstream state.
 * Deliberately NOT `collect_tx_hash IS NOT NULL`, which is set
 * pre-submit (CF-18) — INV-V3: "a persisted `collect_tx_hash` is NOT
 * proof of landing" (money-review V5).
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
          isNotNull(vaultRedemptions.collectedAt),
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
 * operator legitimately holds on the EMISSION side: `shares_minted IS
 * NOT NULL AND transferred_at IS NULL AND state IN ('deposited',
 * 'failed')`. That is: the deposit landed (operator got `shares_minted`
 * shares) but the transfer has NOT confirmed-landed (`transferred_at`
 * NULL). Covers the mid-emission `deposited` case AND the terminal
 * `failed`-with-unconfirmed-transfer case — the operator holds those
 * minted shares until an operator re-drives/refunds. Used by
 * `treasury/hot-float-reconciliation.ts`'s desync check.
 *
 * **The `failed`-with-`transferred_at IS NULL` shares MUST be counted**
 * (money-review V5): a terminal `failed` row whose transfer never
 * confirmed most likely means the transfer did NOT land (had it landed,
 * CF-18's `checkPriorSorobanTx` on retry would have advanced the row to
 * `transferred`, not left it `failed`), so the operator STILL HOLDS
 * them. Excluding them (the earlier `transfer_tx_hash IS NULL` version)
 * was a standing positive phantom in `expectedOperatorShares` that
 * could partially mask a real double-withdraw shortfall. A `failed` row
 * WHERE the transfer DID confirm (`transferred_at IS NOT NULL`) is
 * correctly excluded here (the user holds those — bucket 1 counts them
 * via `sumEmittedTransferredShares`).
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
          isNotNull(vaultEmissions.sharesMinted),
          sql`${vaultEmissions.transferredAt} IS NULL`,
          sql`${vaultEmissions.state} IN ('deposited', 'failed')`,
        ),
      ),
  );
}

/**
 * Bucket (3) — Σ `vault_redemptions.shares_to_redeem` for shares the
 * operator holds from a REDEMPTION collect that CONFIRMED landed but
 * has NOT yet run any payout: `collected_at IS NOT NULL AND payout_path
 * IS NULL AND state IN ('collecting','failed')`. `collected_at IS NOT
 * NULL` (not `collect_tx_hash`, per INV-V3) means the user's shares
 * actually reached the operator; `payout_path IS NULL` is the
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
          isNotNull(vaultRedemptions.collectedAt),
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
