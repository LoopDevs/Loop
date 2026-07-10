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
