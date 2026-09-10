import { config } from './config/index.js';
import { BLUE, escapeMarkdown, sendWebhook } from './discord/shared.js';

export { notifyOrderCreated, notifyOrderFulfilled } from './discord/orders.js';

// ADR 017/018 admin action trail.
export { notifyAdminAudit, notifyAdminBulkRead } from './discord/admin-audit.js';

export {
  notifyHealthChange,
  notifyGeoDbStale,
  notifyPayoutFailed,
  notifyPayoutAwaitingTrustline,
  notifyPayoutTxHashOverwriteRefused,
  notifyPegBreakOnFulfillment,
  notifyInterestPoolLow,
  notifyInterestPoolRecovered,
  notifyAssetDrift,
  notifyAssetDriftRecovered,
  notifyDriftFailedRows,
  notifyDriftFailedRowsCleared,
  notifyVaultShareDrift,
  notifyVaultShareDriftRecovered,
  notifyVaultSolvencyBreach,
  notifyVaultSolvencyRecovered,
  notifyVaultFloatDesync,
  notifyHotFloatBackingShortfall,
  notifyLedgerDrift,
  notifyStuckPayouts,
  notifyRedemptionBackfillExhausted,
  notifyWalletProvisioningStuck,
  notifyVaultEmissionFailed,
  notifyVaultEmissionsStuck,
  notifyVaultRedemptionFailed,
  notifyVaultRedemptionsStuck,
  notifyCtxSchemaDrift,
  notifyCtxCredentialInvalid,
  notifyDuplicateAccountSignal,
  __resetCtxSchemaDriftDedupForTests,
  __resetCtxCredentialDedupForTests,
  __resetAwaitingTrustlineDedupForTests,
} from './discord/monitoring.js';

export type DiscordChannel = 'orders' | 'monitoring' | 'admin-audit';

function webhookUrlFor(channel: DiscordChannel): string | undefined {
  switch (channel) {
    case 'orders':
      return config.observability.discord.ordersWebhook;
    case 'monitoring':
      return config.observability.discord.monitoringWebhook;
    case 'admin-audit':
      return config.observability.discord.adminAuditWebhook;
  }
}

// Distinguishes "delivery attempted" from "URL missing, silent no-op" to prevent swallowing messages on fresh deploys.
export function hasWebhookConfigured(channel: DiscordChannel): boolean {
  const url = webhookUrlFor(channel);
  return url !== undefined && url.length > 0;
}

// Truncates actorId to 8 chars to correlate pings in audit trail without leaking full UUID.
export function notifyWebhookPing(channel: DiscordChannel, actorId: string): void {
  const url = webhookUrlFor(channel);
  const shortActor = actorId.length > 8 ? actorId.slice(0, 8) : actorId;
  void sendWebhook(url, {
    title: '🧪 Test ping',
    description: `Manual test ping from admin \`${escapeMarkdown(shortActor)}\` — delivery proves the webhook URL for the \`${channel}\` channel is wired up.`,
    color: BLUE,
  });
}
