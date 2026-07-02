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
 *
 * Unlike the fire-and-forget notifiers, these four return the
 * `sendWebhook` delivery result (hardening A2): the watcher marks a
 * transition as paged ONLY after a successful send, so an
 * undelivered page (Discord 429/outage, SIGTERM between the state
 * commit and the send) is re-attempted on later ticks instead of
 * being lost forever.
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
}): Promise<boolean> {
  const direction = args.driftStroops.startsWith('-') ? 'Settlement backlog' : 'Over-minted';
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
 * Notify: failed burn / interest-mint payout rows exist for this
 * asset (hardening A2). These rows are counted into the drift
 * equation's un-confirmed terms (the tokens / mirror credits
 * genuinely exist), so the equation itself can never surface them —
 * a terminally-failed nightly mint reads as drift-neutral forever
 * while the user's mirror overstates their on-chain holdings
 * (ADR 036: chain is authoritative). This paired open-alert fires on
 * the none→present transition and stays open until an operator
 * retries the rows via `/admin/payouts?state=failed` →
 * reset-to-pending, at which point `notifyDriftFailedRowsCleared`
 * closes the incident.
 */
export function notifyDriftFailedRows(args: {
  assetCode: string;
  failedBurnStroops: string;
  failedInterestMintStroops: string;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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

/**
 * Notify: the failed burn / interest-mint rows for this asset have
 * been resolved (retried to confirmation, or otherwise converged).
 * Sibling of `notifyDriftFailedRows` — closes the incident.
 */
export function notifyDriftFailedRowsCleared(args: { assetCode: string }): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟢 Failed Money-Movement Rows Cleared',
    description: `\`${escapeMarkdown(args.assetCode)}\` no longer has failed burn / interest-mint payout rows.`,
    color: GREEN,
    fields: [{ name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true }],
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
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
