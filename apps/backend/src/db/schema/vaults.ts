/**
 * Drizzle schema — LOOPUSD/LOOPEUR vault domain (ADR 031 §Detailed
 * design D3, V1 foundation / migration 0060). Re-exported through
 * `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 *
 * V1 ships dark: this module is schema + types only. `loop_vaults`
 * starts EMPTY — the operator inserts the deployed vault addresses
 * post-deploy (ADR 031 §D9 step 1/6; no admin write endpoint exists
 * yet). Every read goes through `credits/vaults/registry.ts`, which
 * additionally gates on `LOOP_VAULTS_ENABLED` (default false).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { orders } from './orders.js';
import { pendingPayouts } from './payments.js';

/**
 * Known LOOP-prefix vault-share asset codes (ADR 031 §Decision). The
 * CHECK constraint on `loop_vaults.asset_code` is the DB-side twin.
 * GBPLOOP is deliberately excluded — it's a classic 1:1-backed Stellar
 * asset with its own interest-mint path (migration 0041), not a
 * DeFindex vault.
 */
export const LOOP_VAULT_ASSET_CODES = ['LOOPUSD', 'LOOPEUR'] as const;
export type LoopVaultAssetCode = (typeof LOOP_VAULT_ASSET_CODES)[number];

/** Networks a vault can be registered on. Mirrors the CHECK constraint. */
export const LOOP_VAULT_NETWORKS = ['testnet', 'mainnet'] as const;
export type LoopVaultNetwork = (typeof LOOP_VAULT_NETWORKS)[number];

/**
 * Vault registry (ADR 031 §D3). One row per (asset_code, network) —
 * the deployed DeFindex vault instance backing LOOPUSD or LOOPEUR on
 * that network: the vault contract address, its share-token identity,
 * the underlying asset it accepts, and which Blend strategy it routes
 * to. `active` lets the operator register a vault ahead of go-live and
 * flip it live without a schema change; `credits/vaults/registry.ts`
 * only ever returns rows where `active = true`.
 */
export const loopVaults = pgTable(
  'loop_vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetCode: text('asset_code').notNull(),
    vaultContractId: text('vault_contract_id').notNull(),
    shareAssetCode: text('share_asset_code').notNull(),
    shareAssetIssuer: text('share_asset_issuer').notNull(),
    underlyingAssetCode: text('underlying_asset_code').notNull(),
    underlyingAssetIssuer: text('underlying_asset_issuer').notNull(),
    strategyId: text('strategy_id').notNull(),
    network: text('network').notNull(),
    feeBps: integer('fee_bps').notNull(),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('loop_vaults_asset_network_unique').on(t.assetCode, t.network),
    check('loop_vaults_asset_code_known', sql`${t.assetCode} IN ('LOOPUSD', 'LOOPEUR')`),
    check('loop_vaults_network_known', sql`${t.network} IN ('testnet', 'mainnet')`),
  ],
);

/**
 * Share-price history (ADR 031 §D3/§D8) — feeds the past-30-day APY
 * computation a later PR wires up (`APY = (price(now)/price(30d_ago))
 * ^ (365/30) − 1`). V1 ships the table plus a record/read helper pair
 * (`credits/vaults/registry.ts`); no scheduled snapshotter or APY
 * endpoint ships in this PR. `sharePricePpm` is parts-per-million of
 * the underlying asset (e.g. 1_050_000 = 1.05 underlying per share).
 * `sourceLedger` is nullable so a manual/backfilled snapshot doesn't
 * need a real Soroban ledger sequence.
 */
export const vaultSharePriceSnapshots = pgTable(
  'vault_share_price_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetCode: text('asset_code').notNull(),
    network: text('network').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    sharePricePpm: bigint('share_price_ppm', { mode: 'bigint' }).notNull(),
    sourceLedger: bigint('source_ledger', { mode: 'bigint' }),
  },
  (t) => [
    // `.desc().nullsFirst()` mirrors the migration's `taken_at DESC`
    // exactly (Postgres DESC defaults to NULLS FIRST; drizzle's bare
    // `.desc()` would emit NULLS LAST) — matches the
    // user_favorite_merchants_user_created precedent so
    // check:migration-parity stays green. Serves "latest share price
    // for (asset, network)" as a bounded index scan.
    index('vault_share_price_snapshots_asset_network_taken').on(
      t.assetCode,
      t.network,
      t.takenAt.desc().nullsFirst(),
    ),
  ],
);

/**
 * Vault-share cashback emission state machine (ADR 031 §D5, V3 —
 * migration 0061). One row per fulfilled order that is emitted
 * through the vault path (`credits/vaults/vault-emissions.ts`)
 * instead of the classic `pending_payouts kind='order_cashback'`
 * path — the two are mutually exclusive per order (see
 * `orders/fulfillment.ts`'s gated fork).
 *
 * `order_id` is the SAME idempotency key the classic path already
 * uses (`pending_payouts_order_unique`, partial on
 * `kind='order_cashback'`) — deliberately reused rather than a fresh
 * generated id, per ADR 031 §D5 step 1's "reuse it, don't invent a
 * parallel one". The UNIQUE constraint below is the durable CLAIM
 * fence: `orders/fulfillment.ts` inserts this row (state='pending')
 * in the SAME transaction as the order's `fulfilled` transition,
 * BEFORE any on-chain action — a crash after that commit always has
 * a resumable claim row; a replay of the same order (shouldn't
 * happen — the order's own `state='procuring'` guard already makes
 * `markOrderFulfilled` a no-op on re-entry — but is additionally
 * fenced here) finds the existing row via `onConflictDoNothing`
 * rather than claiming twice.
 *
 * State machine (§D5): `pending` (claimed, no on-chain action yet)
 * → `depositing` (a sweep has CLAIMED this row for its deposit via
 * an atomic `pending → depositing` state-CAS, committed BEFORE the
 * Soroban deposit's network call — mirrors the payout worker's
 * `pending → submitted` claim) → `deposited` (operator
 * `vault.deposit` landed, shares minted to the operator) →
 * `transferred` (operator → user share transfer landed) → `mirrored`
 * (off-chain `user_credits` liability credited + the `pending_payouts
 * kind='emission'` conservation-trigger audit row written, in one DB
 * transaction). `failed` is a terminal, NON-auto-retried state a row
 * moves to only after `VAULT_EMISSION_MAX_ATTEMPTS` consecutive step
 * failures — it needs an operator look (a Discord page fires the
 * moment a row reaches it; the re-drive ENDPOINT is a follow-up, see
 * that module's header). Every step advance is idempotent /
 * resumable: `deposit_tx_hash` and `transfer_tx_hash` are persisted
 * (CF-18 `onSigned`) BEFORE each network submit, so a crash mid-step
 * resumes via `priorTxHash` rather than re-submitting.
 *
 * The `depositing` state is the load-bearing cross-machine guard: the
 * fleet-wide sweep advisory lock DEGRADES to un-serialized on a
 * transaction-pooler `DATABASE_URL` (`db/client.ts`), so two machines
 * could otherwise both submit a deposit for the same `pending` row (a
 * DOUBLE-deposit / operator-fund leak). The `pending → depositing`
 * CAS (only one machine wins the guarded UPDATE) + the CF-18 hash
 * fence together survive that degradation, exactly as the classic
 * payout worker's `SELECT … FOR UPDATE SKIP LOCKED` + `pending →
 * submitted` CAS + CF-18 do (INV-9). `depositing` allows NULL
 * `shares_minted` (like `pending`) — shares aren't known until the
 * deposit returns.
 */
export const vaultEmissions = pgTable(
  'vault_emissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assetCode: text('asset_code').notNull(),
    network: text('network').notNull(),
    // Cashback owed in the vault's fiat currency's minor units (pence
    // / cents) — the SAME value written to `credit_transactions` /
    // `user_credits` at the mirror step, and the value the deposit
    // step converts to the vault's underlying-asset smallest unit
    // (7-decimal stroops, `cashbackMinor * 100_000`) per the LOOP-asset
    // convention `credits/payout-builder.ts` already documents.
    cashbackMinor: bigint('cashback_minor', { mode: 'bigint' }).notNull(),
    // Destination Stellar address — the user's ACTIVATED embedded
    // wallet (only Soroban-token-capable custody today, ADR 031 §D1).
    // Pinned at claim time like `pending_payouts.to_address`.
    toAddress: text('to_address').notNull(),

    state: text('state').notNull().default('pending'),

    // Slippage floor actually used for the deposit call — audit only
    // (recomputed fresh on every attempt from a live share-price
    // read; not itself re-used across retries).
    minSharesUsed: bigint('min_shares_used', { mode: 'bigint' }),
    depositTxHash: text('deposit_tx_hash'),
    sharesMinted: bigint('shares_minted', { mode: 'bigint' }),
    transferTxHash: text('transfer_tx_hash'),
    // The audit-trail `pending_payouts kind='emission'` row written at
    // the mirror step (see the table doc comment) — lets an admin
    // view join straight from a vault emission to its
    // conservation-trigger-checked payouts-table row.
    pendingPayoutId: uuid('pending_payout_id').references(() => pendingPayouts.id, {
      onDelete: 'set null',
    }),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    depositedAt: timestamp('deposited_at', { withTimezone: true }),
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    mirroredAt: timestamp('mirrored_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    // The durable claim fence (table doc comment) — one vault
    // emission per order, ever.
    uniqueIndex('vault_emissions_order_unique').on(t.orderId),
    // Sweep query shape: `WHERE state IN (...) ORDER BY created_at`.
    index('vault_emissions_state_created').on(t.state, t.createdAt),
    check('vault_emissions_asset_code_known', sql`${t.assetCode} IN ('LOOPUSD', 'LOOPEUR')`),
    check('vault_emissions_network_known', sql`${t.network} IN ('testnet', 'mainnet')`),
    check(
      'vault_emissions_state_known',
      sql`${t.state} IN ('pending', 'depositing', 'deposited', 'transferred', 'mirrored', 'failed')`,
    ),
    check('vault_emissions_cashback_positive', sql`${t.cashbackMinor} > 0`),
    check('vault_emissions_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('vault_emissions_to_address_format', sql`${t.toAddress} ~ '^G[A-Z2-7]{55}$'`),
    // Shape-per-state: a row cannot claim to be further along the
    // pipeline than the fields it actually populated. Mirrors
    // `pending_payouts_kind_shape`'s per-discriminator pattern.
    // `depositing` allows NULL shares_minted (like pending) — the
    // deposit's `onSigned` may have persisted a `deposit_tx_hash`
    // before the crash, but shares aren't known until the call
    // returns and the row advances to `deposited`.
    check(
      'vault_emissions_state_shape',
      sql`
        (${t.state} = 'pending')
        OR (${t.state} = 'depositing')
        OR (${t.state} = 'deposited' AND ${t.depositTxHash} IS NOT NULL AND ${t.sharesMinted} IS NOT NULL)
        OR (${t.state} = 'transferred' AND ${t.depositTxHash} IS NOT NULL AND ${t.sharesMinted} IS NOT NULL AND ${t.transferTxHash} IS NOT NULL)
        OR (${t.state} = 'mirrored' AND ${t.depositTxHash} IS NOT NULL AND ${t.sharesMinted} IS NOT NULL AND ${t.transferTxHash} IS NOT NULL AND ${t.mirroredAt} IS NOT NULL)
        OR (${t.state} = 'failed')
      `,
    ),
  ],
);

/**
 * Source events a vault-share REDEMPTION can be claimed against (ADR
 * 031 §D6, V4 — migration 0062). `'order_redeem'` is the ONLY live
 * writer today (`orders/redeem.ts`'s gated fork of the `loop_asset`
 * gift-card spend path). `'withdrawal'` is scaffolded for a future
 * fiat off-ramp (ADR 036 marks it a "future redemption target") — no
 * caller creates one in V4.
 */
export const VAULT_REDEMPTION_SOURCE_TYPES = ['order_redeem', 'withdrawal'] as const;
export type VaultRedemptionSourceType = (typeof VAULT_REDEMPTION_SOURCE_TYPES)[number];

export const VAULT_REDEMPTION_PAYOUT_PATHS = ['fast', 'slow'] as const;
export type VaultRedemptionPayoutPath = (typeof VAULT_REDEMPTION_PAYOUT_PATHS)[number];

/**
 * Vault-share REDEMPTION state machine (ADR 031 §D6, V4 — migration
 * 0062) — the withdraw/spend mirror of V3's `vaultEmissions`. One row
 * per "spend the vault balance" event: today, exactly one gift-card
 * order redeemed via `paymentMethod='loop_asset'` when the order's
 * `chargeCurrency` is vault-eligible (USD/EUR) and `LOOP_VAULTS_ENABLED`
 * is on — `orders/redeem.ts`'s gated fork of the classic on-chain
 * redemption path (the classic path stays byte-identical for GBPLOOP
 * and for every currency while the flag is off).
 *
 * `(source_type, source_id)` is the durable claim fence — reused, not
 * regenerated, so a re-entrant redeem call always resolves to the SAME
 * row (mirrors `vault_emissions.order_id`'s reuse of the order id).
 *
 * State machine: `pending` (claimed, nothing on-chain yet) →
 * `collecting` (CAS-claimed; covers BOTH "collect landed, not yet
 * paid" and, once the payout succeeds, the same DB state persists
 * `payout_path`/`redeem_tx_hash` before the row advances) → `redeemed`
 * (the user's shares are collected AND the fiat-equivalent value has
 * been paid out — either from the hot float (`payout_path='fast'`) or
 * via a synchronous `vault.withdraw` (`payout_path='slow'`, which also
 * populates `redeem_tx_hash`)) → `settled` (the off-chain
 * `user_credits` liability is debited by `value_minor` AND a
 * `pending_payouts kind='burn'` conservation-trigger audit row is
 * written — REUSING the existing burn primitive `orders/transitions.ts`
 * already writes for classic-asset redemptions, not a new payout kind;
 * for `source_type='order_redeem'` the source order also transitions
 * `pending_payment -> paid` in the SAME DB transaction). `failed` is
 * terminal after `VAULT_REDEMPTION_MAX_ATTEMPTS` consecutive step
 * failures — pages Discord, not auto-retried.
 *
 * Sub-step resume markers (why there are only 4 live states + failed,
 * fewer than `vault_emissions`'s 5): `shares_to_redeem` is computed
 * ONCE from a live share-price read (with a small buffer, ADR 031 §D6
 * step 2) and persisted BEFORE the collect transfer is built — a
 * resume within `collecting` reuses the persisted value rather than
 * recomputing (unlike `vault_emissions.min_shares_used`, which IS
 * recomputed each attempt — that's safe there because it is only a
 * slippage FLOOR on `deposit()`, not the transferred amount itself; a
 * SEP-41 `transfer` has no such floor, so the amount must stay fixed
 * across retries for the CF-18 `priorTxHash` hash-based dedup to ever
 * match). `collect_tx_hash IS NOT NULL` marks "shares collected,
 * proceed to payout, do not re-collect". `payout_path IS NOT NULL`
 * (persisted only once the payout genuinely lands) marks "paid,
 * proceed to mirror, do not re-pay" — the state name `redeemed` itself
 * *is* that marker, since the collecting -> redeemed transition only
 * fires after a successful payout.
 */
export const vaultRedemptions = pgTable(
  'vault_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: text('source_type').notNull().$type<VaultRedemptionSourceType>(),
    // Polymorphic (order id today; a future withdrawal-request id) —
    // no FK, same reasoning `credit_transactions.reference_id` uses.
    sourceId: uuid('source_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assetCode: text('asset_code').notNull(),
    network: text('network').notNull(),
    // Fiat value being redeemed, in the vault currency's minor units —
    // fixed at claim time (the order's chargeMinor for a spend). The
    // mirror debit + burn audit row always use THIS value, never a
    // value derived from the (buffered) share count actually
    // collected — see the table doc comment.
    valueMinor: bigint('value_minor', { mode: 'bigint' }).notNull(),
    // The user's activated embedded wallet — the source of the
    // provider-signed share transfer (ADR 031 §D1).
    fromAddress: text('from_address').notNull(),

    state: text('state').notNull().default('pending'),

    sharesToRedeem: bigint('shares_to_redeem', { mode: 'bigint' }),
    // Money-review P1-B: per-step COLLECT claim lease — an atomic
    // state-CAS a driver stamps BEFORE the user-signed share transfer,
    // so exactly one driver submits the collect even though
    // `state='collecting'` alone doesn't serialize processing (the HTTP
    // inline drive + the sweep can both reach a `collecting` row).
    // Re-acquirable once past the lease so a crashed collector doesn't
    // wedge the row. See `collectSharesStep`.
    collectClaimedAt: timestamp('collect_claimed_at', { withTimezone: true }),
    collectTxHash: text('collect_tx_hash'),
    payoutPath: text('payout_path').$type<VaultRedemptionPayoutPath | null>(),
    // Only set when payoutPath='slow' (a synchronous vault.withdraw
    // was needed because the hot float couldn't cover value_minor).
    redeemTxHash: text('redeem_tx_hash'),
    // The audit-trail `pending_payouts kind='burn'` row written at the
    // mirror step (see the table doc comment).
    pendingPayoutId: uuid('pending_payout_id').references(() => pendingPayouts.id, {
      onDelete: 'set null',
    }),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    // The durable claim fence — one vault redemption per source
    // event, ever.
    uniqueIndex('vault_redemptions_source_unique').on(t.sourceType, t.sourceId),
    // Sweep query shape: `WHERE state IN (...) ORDER BY created_at`.
    index('vault_redemptions_state_created').on(t.state, t.createdAt),
    check(
      'vault_redemptions_source_type_known',
      sql`${t.sourceType} IN ('order_redeem', 'withdrawal')`,
    ),
    check('vault_redemptions_asset_code_known', sql`${t.assetCode} IN ('LOOPUSD', 'LOOPEUR')`),
    check('vault_redemptions_network_known', sql`${t.network} IN ('testnet', 'mainnet')`),
    check(
      'vault_redemptions_state_known',
      sql`${t.state} IN ('pending', 'collecting', 'redeemed', 'settled', 'failed')`,
    ),
    check('vault_redemptions_value_positive', sql`${t.valueMinor} > 0`),
    check('vault_redemptions_attempts_non_negative', sql`${t.attempts} >= 0`),
    check('vault_redemptions_from_address_format', sql`${t.fromAddress} ~ '^G[A-Z2-7]{55}$'`),
    check(
      'vault_redemptions_payout_path_known',
      sql`${t.payoutPath} IS NULL OR ${t.payoutPath} IN ('fast', 'slow')`,
    ),
    check(
      'vault_redemptions_state_shape',
      sql`
        (${t.state} = 'pending')
        OR (${t.state} = 'collecting')
        OR (
          ${t.state} = 'redeemed'
          AND ${t.collectTxHash} IS NOT NULL
          AND ${t.sharesToRedeem} IS NOT NULL
          AND ${t.payoutPath} IS NOT NULL
          AND ${t.redeemedAt} IS NOT NULL
          AND (${t.payoutPath} != 'slow' OR ${t.redeemTxHash} IS NOT NULL)
        )
        OR (
          ${t.state} = 'settled'
          AND ${t.collectTxHash} IS NOT NULL
          AND ${t.sharesToRedeem} IS NOT NULL
          AND ${t.payoutPath} IS NOT NULL
          AND ${t.redeemedAt} IS NOT NULL
          AND (${t.payoutPath} != 'slow' OR ${t.redeemTxHash} IS NOT NULL)
          AND ${t.settledAt} IS NOT NULL
        )
        OR (${t.state} = 'failed')
      `,
    ),
  ],
);

/**
 * Per-(asset_code, network) hot float (ADR 031 §Liquidity safeguard,
 * V4). The operator's canonical-asset (USDC/EURC) working balance,
 * denominated in the vault currency's FIAT minor units (the same
 * convention `vault_redemptions.value_minor` uses) so redemption
 * payouts can draw against it without a share-price conversion at
 * draw time. `pending_unredeemed_shares` tracks vault shares the
 * operator holds from FAST-path collects that have not yet been
 * redeemed via a batched `vault.withdraw` — `treasury/hot-float.ts`'s
 * replenish tick drains this back to the vault and credits the
 * proceeds into `balance_minor`.
 *
 * Starts at zero for every vault (no seed/top-up admin endpoint ships
 * in V4 — mirrors `loop_vaults` shipping empty in V1). A zero float
 * just means every redemption takes the SLOW path (a synchronous
 * `vault.withdraw`) until the float organically grows from slow-path
 * replenishment — still correct, only ever a latency difference.
 */
export const vaultHotFloat = pgTable(
  'vault_hot_float',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetCode: text('asset_code').notNull(),
    network: text('network').notNull(),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull().default(0n),
    pendingUnredeemedShares: bigint('pending_unredeemed_shares', { mode: 'bigint' })
      .notNull()
      .default(0n),
    // MNY-06-hotfloat (migration 0069): sub-minor stroop carry
    // accumulator. `treasury/hot-float.ts`'s replenish tick converts the
    // batched withdraw proceeds to `balance_minor` and holds the
    // `amount_out_stroops % STROOPS_PER_MINOR` remainder HERE instead of
    // truncating it away, flushing a whole minor into `balance_minor`
    // once carry crosses 100_000. Conservation the replenish writer
    // maintains: `balance_minor * 100_000 + carry_stroops == Σ proceeds
    // stroops`. Mirrors the interest-mint carry accumulator
    // (`interest_mint_snapshots.carry_after_stroops`, migration 0041).
    carryStroops: bigint('carry_stroops', { mode: 'bigint' }).notNull().default(0n),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vault_hot_float_asset_network_unique').on(t.assetCode, t.network),
    check('vault_hot_float_asset_code_known', sql`${t.assetCode} IN ('LOOPUSD', 'LOOPEUR')`),
    check('vault_hot_float_network_known', sql`${t.network} IN ('testnet', 'mainnet')`),
    check('vault_hot_float_balance_non_negative', sql`${t.balanceMinor} >= 0`),
    check('vault_hot_float_pending_shares_non_negative', sql`${t.pendingUnredeemedShares} >= 0`),
    // A sub-minor remainder is always in [0, STROOPS_PER_MINOR) — same
    // bounded shape as `interest_mint_snapshots_carry_bounded` (0041).
    check(
      'vault_hot_float_carry_bounded',
      sql`${t.carryStroops} >= 0 AND ${t.carryStroops} < 100000`,
    ),
  ],
);

export const VAULT_FLOAT_RECONCILIATION_STATES = ['ok', 'drift', 'error'] as const;
export type VaultFloatReconciliationState = (typeof VAULT_FLOAT_RECONCILIATION_STATES)[number];

/**
 * Audit trail for `treasury/hot-float-reconciliation.ts`'s float/pool
 * desync check (ADR 031 §D4, V5) — one row per (asset, network) per
 * tick. Compares the operator's ACTUAL on-chain vault-share balance
 * against what the bookkeeping says it should be holding right now:
 * shares in-flight from an emission deposit not yet transferred
 * (`vault_emissions` state `'deposited'`) plus shares collected from a
 * redemption but not yet withdrawn (`vault_hot_float
 * .pending_unredeemed_shares`). A gap here is exactly the V4-accepted
 * "Known residual (NOT self-correcting)" `docs/invariants.md`
 * documents under Vault redemptions — two drivers both landing a real
 * on-chain `vault.withdraw` for the same shares — which has no other
 * reconciler.
 */
export const vaultFloatReconciliationRuns = pgTable(
  'vault_float_reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetCode: text('asset_code').notNull(),
    network: text('network').notNull(),
    operatorShareBalance: bigint('operator_share_balance', { mode: 'bigint' }),
    expectedOperatorShares: bigint('expected_operator_shares', { mode: 'bigint' }),
    shareDelta: bigint('share_delta', { mode: 'bigint' }),
    thresholdShares: bigint('threshold_shares', { mode: 'bigint' }).notNull(),
    state: text('state').notNull().$type<VaultFloatReconciliationState>(),
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vault_float_reconciliation_runs_asset_network_checked').on(
      t.assetCode,
      t.network,
      t.checkedAt,
    ),
    check(
      'vault_float_reconciliation_runs_asset_code_known',
      sql`${t.assetCode} IN ('LOOPUSD', 'LOOPEUR')`,
    ),
    check(
      'vault_float_reconciliation_runs_network_known',
      sql`${t.network} IN ('testnet', 'mainnet')`,
    ),
    check(
      'vault_float_reconciliation_runs_state_known',
      sql`${t.state} IN ('ok', 'drift', 'error')`,
    ),
    check('vault_float_reconciliation_runs_threshold_non_negative', sql`${t.thresholdShares} >= 0`),
    // A computed run (`ok`/`drift`) MUST carry all three numeric
    // columns; an `error` run leaves them NULL. This keeps an `error`
    // row structurally distinguishable from an `ok`/`drift` row with
    // legitimately-zero values (fail-open review P2-3) — a future
    // second writer can't silently record a half-populated computed
    // run.
    check(
      'vault_float_reconciliation_runs_shape',
      sql`
        (${t.state} = 'error')
        OR (
          ${t.state} IN ('ok', 'drift')
          AND ${t.operatorShareBalance} IS NOT NULL
          AND ${t.expectedOperatorShares} IS NOT NULL
          AND ${t.shareDelta} IS NOT NULL
        )
      `,
    ),
  ],
);
