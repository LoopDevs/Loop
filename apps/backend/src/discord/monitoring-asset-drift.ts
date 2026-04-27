/**
 * `notifyAssetDrift` / `notifyAssetDriftRecovered` — paired
 * open-and-close notifiers for the per-asset on-chain ↔ ledger
 * drift watcher (ADR 015).
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` because
 * the two notifiers form one cohesive concern: the watcher fires
 * `notifyAssetDrift` when |drift| crosses the threshold, and
 * `notifyAssetDriftRecovered` on the over→ok transition so the
 * channel reads as a paired open + close incident.
 *
 * Re-exported through `discord/monitoring.ts` (and by extension
 * the top-level `discord.ts` barrel) so existing import sites
 * keep working unchanged.
 */
import { env } from '../env.js';
import { GREEN, ORANGE, escapeMarkdown, sendWebhook } from './shared.js';

/**
 * Notify: per-asset on-chain ↔ ledger drift has exceeded the
 * configured threshold (ADR 015). The drift-watcher polls the
 * Horizon `/assets` endpoint against the off-chain
 * `user_credits` ledger and fires this when |drift| crosses the
 * threshold. Direction baked into the title + description so ops
 * doesn't have to read the sign byte to know whether we're over-
 * minted (issuer side leaked supply) or behind on settlement.
 */
export function notifyAssetDrift(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
  onChainStroops: string;
  ledgerLiabilityMinor: string;
}): void {
  const direction = args.driftStroops.startsWith('-') ? 'Settlement backlog' : 'Over-minted';
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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

/**
 * Notify: a previously-drifting asset has returned within the
 * threshold. Sibling of `notifyAssetDrift` — fires on over→ok so
 * the channel reads as a closed incident rather than an indefinite
 * open alert.
 */
export function notifyAssetDriftRecovered(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
