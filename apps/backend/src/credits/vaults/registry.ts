/**
 * LOOPUSD/LOOPEUR vault registry — read layer (ADR 031 §Detailed
 * design D3/D9, V1 foundation).
 *
 * V1 is schema + config + this read layer only — NO Soroban client,
 * NO emission/withdraw logic (those are later PRs, §D5/D6). Ships
 * dark: `loop_vaults` starts EMPTY (the operator inserts the deployed
 * vault addresses post-deploy per §D9 step 1/6 — no admin write
 * endpoint exists yet) and every function here ALSO gates on
 * `LOOP_VAULTS_ENABLED` (default false), belt-and-suspenders so a
 * populated-but-not-yet-live registry still can't be read by anything
 * downstream. `vaultsEnabled()` false → every read returns
 * null/empty regardless of what's actually in the tables.
 *
 * `getActiveVault` / `listActiveVaults` only ever return rows with
 * `active = true` — an operator can insert a vault row ahead of
 * go-live (e.g. to stage config) without it being usable yet.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  loopVaults,
  vaultSharePriceSnapshots,
  type LoopVaultAssetCode,
  type LoopVaultNetwork,
} from '../../db/schema.js';
import { env } from '../../env.js';

export type LoopVaultRow = typeof loopVaults.$inferSelect;
export type VaultSharePriceSnapshotRow = typeof vaultSharePriceSnapshots.$inferSelect;

/**
 * The vault-subsystem master switch (distinct from `LOOP_PHASE_1_ONLY`,
 * which gates the user-facing cashback/wallet surface generally).
 * Every read in this module checks this first — dark by default even
 * once `loop_vaults` has rows.
 */
export function vaultsEnabled(): boolean {
  return env.LOOP_VAULTS_ENABLED;
}

/**
 * The active vault registered for `assetCode` on `network`, or `null`
 * if none is registered (or the row exists but `active = false`, or
 * the subsystem is disabled). The `(asset_code, network)` unique index
 * guarantees at most one match.
 */
export async function getActiveVault(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<LoopVaultRow | null> {
  if (!vaultsEnabled()) return null;
  const rows = await db
    .select()
    .from(loopVaults)
    .where(
      and(
        eq(loopVaults.assetCode, assetCode),
        eq(loopVaults.network, network),
        eq(loopVaults.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every active vault registered on `network` (at most one per asset
 * code today — LOOPUSD and LOOPEUR — but callers should not assume a
 * fixed length). Empty when the subsystem is disabled.
 */
export async function listActiveVaults(network: LoopVaultNetwork): Promise<LoopVaultRow[]> {
  if (!vaultsEnabled()) return [];
  return db
    .select()
    .from(loopVaults)
    .where(and(eq(loopVaults.network, network), eq(loopVaults.active, true)));
}

/**
 * Records a share-price sample for `(assetCode, network)`. Used by
 * later APY work (ADR 031 §D8); V1 ships the helper with no scheduled
 * caller. No-ops when the subsystem is disabled — callers don't need
 * to check `vaultsEnabled()` themselves before recording.
 */
export async function recordSharePriceSnapshot(input: {
  assetCode: LoopVaultAssetCode;
  network: LoopVaultNetwork;
  sharePricePpm: bigint;
  sourceLedger?: bigint | null;
  takenAt?: Date;
}): Promise<void> {
  if (!vaultsEnabled()) return;
  await db.insert(vaultSharePriceSnapshots).values({
    assetCode: input.assetCode,
    network: input.network,
    sharePricePpm: input.sharePricePpm,
    sourceLedger: input.sourceLedger ?? null,
    ...(input.takenAt !== undefined ? { takenAt: input.takenAt } : {}),
  });
}

/**
 * The most recent share-price sample for `(assetCode, network)`, or
 * `null` if none has been recorded (or the subsystem is disabled).
 * Uses the `vault_share_price_snapshots_asset_network_taken` index
 * (leading `asset_code, network`, `taken_at DESC`) — a bounded index
 * scan, not a full-table sort.
 */
export async function getLatestSharePrice(
  assetCode: LoopVaultAssetCode,
  network: LoopVaultNetwork,
): Promise<VaultSharePriceSnapshotRow | null> {
  if (!vaultsEnabled()) return null;
  const rows = await db
    .select()
    .from(vaultSharePriceSnapshots)
    .where(
      and(
        eq(vaultSharePriceSnapshots.assetCode, assetCode),
        eq(vaultSharePriceSnapshots.network, network),
      ),
    )
    .orderBy(desc(vaultSharePriceSnapshots.takenAt))
    .limit(1);
  return rows[0] ?? null;
}
