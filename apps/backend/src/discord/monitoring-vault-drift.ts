// vault drift/solvency/float notifiers — ADR 031 §D4, V5, A2, R3-1
import { config } from '../config/index.js';
import { GREEN, ORANGE, escapeMarkdown, sendWebhook } from './shared.js';

// INV-V1: on-chain vs off-chain share count drift; both directions indicate failure
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
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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

export function notifyVaultShareDriftRecovered(args: {
  assetCode: string;
  network: string;
  driftShares: string;
  thresholdShares: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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

// INV-V2: off-chain USD liability exceeds redeemable backing + hot float; independent of vault share price
export function notifyVaultSolvencyBreach(args: {
  assetCode: string;
  network: string;
  mirrorLiabilityStroops: string;
  redeemableBackingStroops: string;
  hotFloatStroops: string;
  breachStroops: string;
  thresholdStroops: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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

export function notifyVaultSolvencyRecovered(args: {
  assetCode: string;
  network: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟢 Vault Solvency Breach Recovered (INV-V2)',
    description: `\`${escapeMarkdown(args.assetCode)}\` (${escapeMarkdown(args.network)}) is back within its solvency tolerance.`,
    color: GREEN,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
    ],
  });
}

// V4-accepted "Known residual" reconciler; pages on every bad-state run (R3-1 pattern) due to slow cadence
export function notifyVaultFloatDesync(args: {
  assetCode: string;
  network: string;
  operatorShareBalance: string;
  expectedOperatorShares: string;
  shareDelta: string;
  thresholdShares: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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
