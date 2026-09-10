// NS-06 hot-float USDC-backing pager — A2
import { config } from '../config/index.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { DESCRIPTION_MAX, ORANGE, RED, escapeMarkdown, sendWebhook, truncate } from './shared.js';

export interface HotFloatBackingShortfallArgs {
  network: string;
  underlyingAssetCode: string;
  account: string;
  recordedFloatStroops: string | null;
  onchainUsdcStroops: string | null;
  shortfallStroops: string | null;
  thresholdStroops: string;
  state: 'drift' | 'error';
  error: string | null;
}

export function notifyHotFloatBackingShortfall(
  args: HotFloatBackingShortfallArgs,
): Promise<boolean> {
  if (args.state === 'error') {
    return sendWebhook(config.observability.discord.monitoringWebhook, {
      title: '🔴 Hot-Float Backing Reconciliation — check failed',
      // Scrub then escape to prevent leaking internals (URLs/secrets) from thrown errors.
      description: truncate(
        args.error !== null
          ? escapeMarkdown(scrubUpstreamBody(args.error))
          : `Could not reconcile the ${escapeMarkdown(args.underlyingAssetCode)} hot-float backing on ${escapeMarkdown(args.network)}.`,
        DESCRIPTION_MAX,
      ),
      color: RED,
      fields: [
        { name: 'Network', value: escapeMarkdown(args.network), inline: true },
        {
          name: 'Underlying',
          value: `\`${escapeMarkdown(args.underlyingAssetCode)}\``,
          inline: true,
        },
        { name: 'Account', value: `\`${escapeMarkdown(args.account)}\``, inline: true },
      ],
    });
  }
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🛑 Hot-Float USDC Backing Shortfall',
    description: `\`${escapeMarkdown(args.underlyingAssetCode)}\` (${escapeMarkdown(args.network)}): the RECORDED hot-float balance solvency counts as backing exceeds the operator's ACTUAL on-chain USDC beyond tolerance — the float may be partially UNBACKED. Triage /api/admin/treasury and the vault_hot_float rows before treating the float as solvent backing.`,
    color: ORANGE,
    fields: [
      { name: 'Network', value: escapeMarkdown(args.network), inline: true },
      {
        name: 'Underlying',
        value: `\`${escapeMarkdown(args.underlyingAssetCode)}\``,
        inline: true,
      },
      { name: 'Account', value: `\`${escapeMarkdown(args.account)}\``, inline: true },
      {
        name: 'Recorded float (stroops)',
        value: escapeMarkdown(args.recordedFloatStroops ?? 'unknown'),
        inline: true,
      },
      {
        name: 'On-chain USDC (stroops)',
        value: escapeMarkdown(args.onchainUsdcStroops ?? 'unknown'),
        inline: true,
      },
      {
        name: 'Shortfall (stroops)',
        value: escapeMarkdown(args.shortfallStroops ?? 'unknown'),
        inline: true,
      },
      {
        name: 'Threshold (stroops)',
        value: escapeMarkdown(args.thresholdStroops),
        inline: true,
      },
    ],
  });
}
