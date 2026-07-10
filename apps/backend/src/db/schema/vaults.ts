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
