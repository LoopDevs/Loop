import { config } from './config/index.js';
import { BLUE, escapeMarkdown, sendWebhook } from './discord/shared.js';

// Orders-channel notifiers (5 functions) live in `./discord/orders.ts`.
// Re-exported here so existing call sites
// (`notifyOrderCreated` etc. imported from `./discord.js`) keep
// working without re-targeting their imports.
export { notifyOrderCreated, notifyOrderFulfilled } from './discord/orders.js';

// ADR 017/018 admin action trail. Lives in `./discord/admin-audit.ts`;
// re-exported here so admin handlers import notifiers from one place.
export { notifyAdminAudit, notifyAdminBulkRead } from './discord/admin-audit.js';

// Monitoring-channel notifiers (covering health, payouts, asset
// drift, stuck-row sweepers, redemption backfill, upstream contract,
// circuit breaker — plus dedup-state test seams) live in
// `./discord/monitoring.ts`. Re-exported here so existing call
// sites keep working without re-targeting.
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

/**
 * Discord channels the backend posts to. Mirrors the webhooks under
 * `observability.discord` — keeping this as a closed union means
 * adding a new channel is a type-level change.
 */
export type DiscordChannel = 'orders' | 'monitoring' | 'admin-audit';

/**
 * Resolves the raw webhook URL for a given channel. Centralised so
 * the test-ping handler + the catalog stay in lockstep — one place
 * in this module maps channel → env var.
 */
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

/**
 * True when the given channel's webhook env var is set. Admin
 * test-ping uses this to distinguish "we tried to deliver" from
 * "URL was never configured, delivery was a silent no-op". Without
 * the check, a freshly-deployed backend with a missing env var
 * would swallow every message indistinguishably from success.
 */
export function hasWebhookConfigured(channel: DiscordChannel): boolean {
  const url = webhookUrlFor(channel);
  return url !== undefined && url.length > 0;
}

/**
 * Fires a benign test ping on a channel so an admin can verify
 * webhook wiring after rotating env vars or redeploying. `actorId`
 * is truncated to 8 chars in the embed so the audit trail can
 * correlate the ping to the admin who triggered it without leaking
 * the full uuid to the channel.
 *
 * Fire-and-forget like every other notifier — the caller should
 * already have checked `hasWebhookConfigured(channel)` before
 * invoking this (the admin handler maps an unconfigured channel to
 * a 409 so the UI shows "webhook not configured" instead of a
 * silent 200).
 */
export function notifyWebhookPing(channel: DiscordChannel, actorId: string): void {
  const url = webhookUrlFor(channel);
  const shortActor = actorId.length > 8 ? actorId.slice(0, 8) : actorId;
  void sendWebhook(url, {
    title: '🧪 Test ping',
    description: `Manual test ping from admin \`${escapeMarkdown(shortActor)}\` — delivery proves the webhook URL for the \`${channel}\` channel is wired up.`,
    color: BLUE,
  });
}
