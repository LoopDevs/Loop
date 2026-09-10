// per-asset drift & failed-row notifiers — ADR 015, A2, ADR 036
import { config } from '../config/index.js';
import { GREEN, ORANGE, escapeMarkdown, sendWebhook } from './shared.js';

// Returns delivery result so watcher only marks paged after success; undelivered pages retry on next tick (A2)
export function notifyAssetDrift(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
  onChainStroops: string;
  ledgerLiabilityMinor: string;
}): Promise<boolean> {
  const direction = args.driftStroops.startsWith('-') ? 'Settlement backlog' : 'Over-minted';
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '⚠️ Asset Drift Exceeded Threshold',
    description: `\`${escapeMarkdown(args.assetCode)}\` drift exceeds the configured threshold. Direction: **${direction}**.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Drift (stroops)', value: escapeMarkdown(args.driftStroops), inline: true },
      { name: 'Threshold (stroops)', value: escapeMarkdown(args.thresholdStroops), inline: true },
      { name: 'On-chain (stroops)', value: escapeMarkdown(args.onChainStroops), inline: true },
      {
        name: 'Ledger (minor)',
        value: escapeMarkdown(args.ledgerLiabilityMinor),
        inline: true,
      },
    ],
  });
}

// Failed rows count as in-flight in drift equation, keeping drift neutral while mirror diverges from chain (ADR 036)
export function notifyDriftFailedRows(args: {
  assetCode: string;
  failedBurnStroops: string;
  failedInterestMintStroops: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '⚠️ Failed Money-Movement Rows Need Retry',
    description: `\`${escapeMarkdown(args.assetCode)}\` has terminally-failed burn / interest-mint payout rows. The drift equation counts these as in-flight, so drift stays neutral while the mirror diverges from chain — retry them via /admin/payouts?state=failed.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      {
        name: 'Failed burns (stroops)',
        value: escapeMarkdown(args.failedBurnStroops),
        inline: true,
      },
      {
        name: 'Failed interest mints (stroops)',
        value: escapeMarkdown(args.failedInterestMintStroops),
        inline: true,
      },
    ],
  });
}

export function notifyDriftFailedRowsCleared(args: { assetCode: string }): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟢 Failed Money-Movement Rows Cleared',
    description: `\`${escapeMarkdown(args.assetCode)}\` no longer has failed burn / interest-mint payout rows.`,
    color: GREEN,
    fields: [{ name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true }],
  });
}

export function notifyAssetDriftRecovered(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟢 Asset Drift Recovered',
    description: `\`${escapeMarkdown(args.assetCode)}\` drift is back within the configured threshold.`,
    color: GREEN,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Drift (stroops)', value: escapeMarkdown(args.driftStroops), inline: true },
      { name: 'Threshold (stroops)', value: escapeMarkdown(args.thresholdStroops), inline: true },
    ],
  });
}
