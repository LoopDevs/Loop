/**
 * `notifyVaultShareDrift` / `notifyVaultShareDriftRecovered` /
 * `notifyVaultSolvencyBreach` / `notifyVaultSolvencyRecovered` —
 * paired open-and-close notifiers for `credits/vaults/
 * vault-drift-watcher.ts` (ADR 031 §D4, V5). Same shape as
 * `monitoring-asset-drift.ts`'s `notifyAssetDrift` /
 * `notifyAssetDriftRecovered` pair, split into two independent
 * dimensions (INV-V1 share-count drift vs INV-V2 solvency) since a
 * vault can breach one without the other.
 *
 * Re-exported through `discord/monitoring.ts` (and by extension the
 * top-level `discord.ts` barrel).
 *
 * Return the `sendWebhook` delivery result (hardening A2 pattern) so
 * the watcher marks a transition as paged ONLY after a confirmed
 * send — an undelivered page is re-attempted on the next tick rather
 * than lost.
 */
import { env } from '../env.js';
import { GREEN, ORANGE, escapeMarkdown, sendWebhook } from './shared.js';

/**
 * Notify: INV-V1 breach — the on-chain shares held by users (derived
 * as `totalSupply - operatorShareBalance`) has drifted from the
 * off-chain-tracked net shares (emitted-transferred minus
 * redeemed-collected) beyond the configured threshold. Either
 * direction is worth paging: on-chain > tracked means unaccounted
 * shares exist somewhere (a potential unbacked-share event); tracked
 * > on-chain means the mirror thinks users hold more than they
 * actually do on-chain (a stuck/lost transfer).
 */
export function notifyVaultShareDrift(args: {
  assetCode: string;
  network: string;
  driftShares: string;
  thresholdShares: string;
  onChainUserShares: string;
  offChainTrackedShares: string;
}): Promise<boolean> {
  const direction = args.driftShares.startsWith('-')
    ? 'Off-chain tracks MORE than on-chain (possible stuck/lost transfer)'
    : 'On-chain holds MORE than off-chain tracks (possible unaccounted shares)';
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '⚠️ Vault Share-Count Drift Exceeded Threshold (INV-V1)',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}) user-share drift exceeds the configured threshold. ${direction}.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
      { name: 'Drift (shares)', value: escapeMarkdown(args.driftShares), inline: true },
      { name: 'Threshold (shares)', value: escapeMarkdown(args.thresholdShares), inline: true },
      {
        name: 'On-chain user shares',
        value: escapeMarkdown(args.onChainUserShares),
        inline: true,
      },
      {
        name: 'Off-chain tracked shares',
        value: escapeMarkdown(args.offChainTrackedShares),
        inline: true,
      },
    ],
  });
}

/** Sibling of `notifyVaultShareDrift` — fires on over→ok. */
export function notifyVaultShareDriftRecovered(args: {
  assetCode: string;
  network: string;
  driftShares: string;
  thresholdShares: string;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟢 Vault Share-Count Drift Recovered (INV-V1)',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}) user-share drift is back within the configured threshold.`,
    color: GREEN,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
      { name: 'Drift (shares)', value: escapeMarkdown(args.driftShares), inline: true },
      { name: 'Threshold (shares)', value: escapeMarkdown(args.thresholdShares), inline: true },
    ],
  });
}

/**
 * Notify: INV-V2 breach — the vault path's own off-chain USD liability
 * (fixed cashback we credited, minus what we debited on redemption)
 * exceeds the vault's redeemable backing (`totalManaged`) plus the
 * currency's hot float, beyond the configured tolerance. This is the
 * solvency signal: a genuine Blend/DeFindex strategy impairment drops
 * `totalManaged` below the fixed liability and fires here. (The
 * liability is INDEPENDENT of the vault's self-reported share price —
 * see `vault-drift-watcher.ts`'s header for why the tempting
 * on-chain-share-value formulation is tautologically dead.)
 */
export function notifyVaultSolvencyBreach(args: {
  assetCode: string;
  network: string;
  mirrorLiabilityStroops: string;
  redeemableBackingStroops: string;
  hotFloatStroops: string;
  breachStroops: string;
  thresholdStroops: string;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🛑 Vault Solvency Breach (INV-V2)',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}): off-chain USD liability exceeds vault-redeemable backing + hot float beyond tolerance.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
      {
        name: 'Mirror liability (stroops)',
        value: escapeMarkdown(args.mirrorLiabilityStroops),
        inline: true,
      },
      {
        name: 'Redeemable backing (stroops)',
        value: escapeMarkdown(args.redeemableBackingStroops),
        inline: true,
      },
      { name: 'Hot float (stroops)', value: escapeMarkdown(args.hotFloatStroops), inline: true },
      { name: 'Breach (stroops)', value: escapeMarkdown(args.breachStroops), inline: true },
      {
        name: 'Threshold (stroops)',
        value: escapeMarkdown(args.thresholdStroops),
        inline: true,
      },
    ],
  });
}

/** Sibling of `notifyVaultSolvencyBreach` — fires on breach→ok. */
export function notifyVaultSolvencyRecovered(args: {
  assetCode: string;
  network: string;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟢 Vault Solvency Breach Recovered (INV-V2)',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}) is back within its solvency tolerance.`,
    color: GREEN,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
    ],
  });
}

/**
 * Notify: `treasury/hot-float-reconciliation.ts`'s float/pool desync
 * check — the operator's ACTUAL on-chain vault-share balance
 * disagrees with what the emission/redemption bookkeeping says it
 * should currently be holding (in-flight deposited shares + hot-float
 * pending-unredeemed shares), beyond tolerance. This is the reconciler
 * for the V4-accepted "Known residual" documented under Vault
 * redemptions in docs/invariants.md — a genuine float/pool desync
 * (e.g. a double-withdraw race) with no other detector. Unlike the
 * fire-once watchdogs above, this pages on EVERY bad-state run
 * (same at-least-once-reminder posture as `notifyOperatorFloatDrift`
 * — R3-1's own pattern) rather than deduping to one page per incident,
 * since this check runs on a slow (daily-default) cadence.
 */
export function notifyVaultFloatDesync(args: {
  assetCode: string;
  network: string;
  operatorShareBalance: string;
  expectedOperatorShares: string;
  shareDelta: string;
  thresholdShares: string;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '⚠️ Vault Hot-Float Reconciliation Drift',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}): the operator's on-chain vault-share balance disagrees with the float/emission bookkeeping beyond tolerance.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
      {
        name: 'Operator share balance (on-chain)',
        value: escapeMarkdown(args.operatorShareBalance),
        inline: true,
      },
      {
        name: 'Expected operator shares (bookkeeping)',
        value: escapeMarkdown(args.expectedOperatorShares),
        inline: true,
      },
      { name: 'Delta (shares)', value: escapeMarkdown(args.shareDelta), inline: true },
      { name: 'Threshold (shares)', value: escapeMarkdown(args.thresholdShares), inline: true },
    ],
  });
}
