/**
 * `notifyHotFloatBackingShortfall` — the pager for NS-06's hot-float
 * USDC-backing reconciler (`treasury/hot-float-backing-reconciliation.ts`).
 *
 * Sibling of `monitoring-vault-drift.ts`'s `notifyVaultFloatDesync`
 * (which pages the operator's on-chain vault-SHARE reconciliation); this
 * pages the USDC-BALANCE reconciliation those shares back. Fires when the
 * RECORDED hot-float balance the INV-V2 solvency check trusts as backing
 * exceeds the operator's ACTUAL on-chain USDC beyond tolerance (a
 * `drift`), or when the reconciler could not read the balance at all (an
 * `error`). Like `notifyVaultFloatDesync` / `notifyOperatorFloatDrift`,
 * this pages on EVERY bad-state run (at-least-once reminder) rather than
 * deduping to one page per incident, since the reconciler runs on a slow
 * (daily-default) cadence.
 *
 * Returns the `sendWebhook` delivery result (hardening A2 pattern) so a
 * caller can treat an undelivered page as not-yet-sent.
 *
 * Re-exported through `discord/monitoring.ts` (and the top-level
 * `discord.ts` barrel).
 */
import { env } from '../env.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { DESCRIPTION_MAX, ORANGE, RED, escapeMarkdown, sendWebhook, truncate } from './shared.js';

export interface HotFloatBackingShortfallArgs {
  network: string;
  underlyingAssetCode: string;
  account: string;
  /** Σ recorded hot-float balance over the USDC-backed vaults, in USDC stroops. `null` on an `error` run. */
  recordedFloatStroops: string | null;
  /** Operator's actual on-chain USDC, in stroops. `null` on an `error` run. */
  onchainUsdcStroops: string | null;
  /** `recorded − onchain` (positive = unbacked shortfall). `null` on an `error` run. */
  shortfallStroops: string | null;
  thresholdStroops: string;
  state: 'drift' | 'error';
  /** Caught exception message on the `error` path; scrubbed + escaped before it reaches the embed. */
  error: string | null;
}

export function notifyHotFloatBackingShortfall(
  args: HotFloatBackingShortfallArgs,
): Promise<boolean> {
  if (args.state === 'error') {
    return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
      title: '🔴 Hot-Float Backing Reconciliation — check failed',
      // The raw message can carry internals (a URL / secret that surfaced
      // in the thrown error) — scrub then escape it exactly as
      // `notifyOperatorFloatDrift` does before embedding.
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
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
