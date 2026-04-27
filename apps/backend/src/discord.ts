import { env } from './env.js';
import { BLUE, escapeMarkdown, sendWebhook } from './discord/shared.js';

// Orders-channel notifiers (5 functions) live in `./discord/orders.ts`.
// Re-exported here so existing call sites
// (`notifyOrderCreated` etc. imported from `./discord.js`) keep
// working without re-targeting their imports.
export {
  notifyOrderCreated,
  notifyCashbackRecycled,
  notifyFirstCashbackRecycled,
  notifyOrderFulfilled,
  notifyCashbackCredited,
} from './discord/orders.js';

// Monitoring-channel notifiers (12 functions covering health,
// payouts, asset drift, stuck-row sweepers, upstream contract,
// circuit breaker — plus 2 dedup-state test seams) live in
// `./discord/monitoring.ts`. Re-exported here so existing call
// sites keep working without re-targeting.
export {
  notifyHealthChange,
  notifyPayoutFailed,
  notifyUsdcBelowFloor,
  notifyAssetDrift,
  notifyAssetDriftRecovered,
  notifyStuckProcurementSwept,
  notifyPaymentWatcherStuck,
  notifyCtxSchemaDrift,
  notifyOperatorPoolExhausted,
  notifyCircuitBreaker,
  __resetCircuitNotifyDedupForTests,
  __resetCtxSchemaDriftDedupForTests,
} from './discord/monitoring.js';

// Admin-audit channel notifiers (3 functions covering admin
// writes, bulk-read exports, cashback-config diffs) plus the
// `CashbackConfigSnapshot` type live in `./discord/admin-audit.ts`.
// Re-exported here so existing call sites keep working.
export {
  type CashbackConfigSnapshot,
  notifyAdminAudit,
  notifyAdminBulkRead,
  notifyCashbackConfigChanged,
} from './discord/admin-audit.js';

/**
 * Discord channels the backend posts to. Mirrors the three
 * `DISCORD_WEBHOOK_*` env vars — keeping this as a closed union
 * means adding a new channel is a type-level change that forces
 * every catalog entry to declare which channel it posts to.
 */
export type DiscordChannel = 'orders' | 'monitoring' | 'admin-audit';

/**
 * One catalogued notifier — the function name, the channel it posts
 * to, and a one-line description of when it fires. Catalog is an
 * `Object.freeze`d const so runtime mutation throws (the admin
 * endpoint surfaces this read-only; nobody should be rewriting it).
 */
export interface DiscordNotifier {
  name: string;
  channel: DiscordChannel;
  description: string;
}

/**
 * Resolves the raw webhook URL for a given channel. Centralised so
 * the test-ping handler + the catalog stay in lockstep — one place
 * in this module maps channel → env var.
 */
function webhookUrlFor(channel: DiscordChannel): string | undefined {
  switch (channel) {
    case 'orders':
      return env.DISCORD_WEBHOOK_ORDERS;
    case 'monitoring':
      return env.DISCORD_WEBHOOK_MONITORING;
    case 'admin-audit':
      return env.DISCORD_WEBHOOK_ADMIN_AUDIT;
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

/**
 * Static catalog of the Discord notifiers the backend can emit
 * (ADR 018 operational-visibility surface).
 *
 * Lives in `./discord/notifiers-catalog.ts`. Re-exported below so
 * existing import sites (admin handler, the OpenAPI spec) keep
 * resolving against the historical `./discord.js` path.
 *
 * Keep the entries sorted by channel first, then by function name so
 * the admin-rendered table is stable and diff-friendly.
 */
export { DISCORD_NOTIFIERS } from './discord/notifiers-catalog.js';
