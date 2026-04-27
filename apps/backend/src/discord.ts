import { env } from './env.js';
import {
  BLUE,
  FIELD_VALUE_MAX,
  GREEN,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './discord/shared.js';

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

/**
 * Notify: admin write action (ADR 017/018). Called fire-and-forget
 * AFTER the DB commit of every admin mutation. Actor id truncated to
 * the last 8 chars so the embed doesn't expose a full uuid; full id
 * is still in the ledger for audit. A2-511: actor email dropped from
 * the embed — the tail-id convention is the Discord-side identifier,
 * and admin emails are reserved for the ledger row (where they're
 * useful) rather than the webhook feed (where they aren't).
 */
export function notifyAdminAudit(args: {
  actorUserId: string;
  endpoint: string;
  targetUserId?: string;
  amountMinor?: string;
  currency?: string;
  reason: string;
  idempotencyKey: string;
  replayed: boolean;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.targetUserId !== undefined) {
    fields.push({
      name: 'Target user',
      value: `\`${args.targetUserId.slice(-8)}\``,
      inline: true,
    });
  }
  if (args.amountMinor !== undefined && args.currency !== undefined) {
    fields.push({
      name: 'Amount (minor)',
      value: `${escapeMarkdown(args.amountMinor)} ${escapeMarkdown(args.currency)}`,
      inline: true,
    });
  }
  fields.push({
    name: 'Reason',
    value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
    inline: false,
  });
  fields.push({
    name: 'Idempotency-Key',
    value: `\`${escapeMarkdown(args.idempotencyKey).slice(0, 32)}\``,
    inline: true,
  });
  if (args.replayed) {
    fields.push({ name: 'Replayed', value: 'yes', inline: true });
  }
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: args.replayed ? '🔁 Admin write (replayed)' : '🛠️ Admin write',
    color: args.replayed ? BLUE : GREEN,
    fields,
  });
}

/**
 * A2-2008: bulk-read audit notification. Admin reads are a separate
 * surface from admin writes — logging every single-row drill would
 * flood the channel — but bulk exports (CSV downloads, full-list
 * pulls past a row threshold) are a high-PII surface where a
 * malicious or mis-targeted admin can exfiltrate user data without
 * leaving a trace.
 *
 * Fires on:
 *   - any `GET /api/admin/*.csv` 200 response
 *   - admin GETs flagged as "bulk" by the middleware (large-page
 *     full lists)
 *
 * The Pino access log (server-side, ships off-host via Fly logflow)
 * is the line-item read audit; this Discord post is the human-visible
 * "someone's running an export right now" signal.
 */
export function notifyAdminBulkRead(args: {
  actorUserId: string;
  endpoint: string;
  /** Optional query string (truncated) for context. */
  queryString?: string;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.queryString !== undefined && args.queryString.length > 0) {
    fields.push({
      name: 'Query',
      value: `\`${truncate(escapeMarkdown(args.queryString), 200)}\``,
      inline: false,
    });
  }
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: '📤 Admin bulk read',
    color: BLUE,
    fields,
  });
}

/**
 * Notify: merchant cashback-config create / update (ADR 011 / 018).
 * Called fire-and-forget AFTER the DB upsert commits, from
 * `upsertConfigHandler`. The admin-audit channel already receives a
 * generic `notifyAdminAudit` line; this one is the domain-specific
 * view with the old → new pct diff so the commercial impact of the
 * edit is readable in Discord.
 *
 * `previous` is null for first-time creates (no prior row to diff).
 * Actor id is truncated to the last 8 chars per ADR 018 convention.
 * `merchantName` falls back to merchantId at the call site — we
 * don't redo the fallback here so the embed text reflects what the
 * admin actually saw in the UI.
 */
export interface CashbackConfigSnapshot {
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
}

export function notifyCashbackConfigChanged(args: {
  merchantId: string;
  merchantName: string;
  actorUserId: string;
  previous: CashbackConfigSnapshot | null;
  next: CashbackConfigSnapshot;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: 'Merchant',
      value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
      inline: true,
    },
    { name: 'Admin', value: `\`${actorTail}\``, inline: true },
    {
      name: 'New',
      value: fmtConfigLine(args.next),
      inline: false,
    },
  ];
  if (args.previous !== null) {
    fields.push({
      name: 'Previous',
      value: fmtConfigLine(args.previous),
      inline: false,
    });
  }
  const isCreate = args.previous === null;
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: isCreate ? '🟢 Cashback config created' : '🔧 Cashback config updated',
    color: isCreate ? GREEN : BLUE,
    fields,
  });
}

function fmtConfigLine(s: CashbackConfigSnapshot): string {
  const body =
    `wholesale ${escapeMarkdown(s.wholesalePct)}%` +
    ` · cashback ${escapeMarkdown(s.userCashbackPct)}%` +
    ` · margin ${escapeMarkdown(s.loopMarginPct)}%` +
    ` · ${s.active ? 'active' : 'inactive'}`;
  return truncate(body, FIELD_VALUE_MAX);
}

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
 * Keeping the list in code rather than in prose makes it:
 *
 * - **ADR-drift-resistant** — ADR 018 names the taxonomy; a new
 *   notifier landing without updating this const would be caught in
 *   review because the admin UI's surface would silently omit it.
 * - **Zero-DB** — admin handler reads this directly, no round trip.
 * - **Safe for UI** — `channel` is the enum, not the webhook URL, so
 *   no secrets leak through the catalog surface.
 *
 * Keep the entries sorted by channel first, then by function name so
 * the admin-rendered table is stable and diff-friendly.
 */
export const DISCORD_NOTIFIERS: ReadonlyArray<DiscordNotifier> = Object.freeze([
  {
    name: 'notifyAdminAudit',
    channel: 'admin-audit',
    description:
      'Every successful admin write (ADR 017). One line per mutation with the actor, method, path, status, and replay flag.',
  },
  {
    name: 'notifyAdminBulkRead',
    channel: 'admin-audit',
    description:
      'A2-2008 bulk-read audit. Fires on every successful admin CSV export or full-list bulk read. Single-row drills land in Pino only (would flood the channel).',
  },
  {
    name: 'notifyCashbackConfigChanged',
    channel: 'admin-audit',
    description:
      'Fires on merchant cashback-config create / update (ADR 011). Embeds the old→new pct diff so the commercial impact of the edit is legible in the channel without drilling to the admin UI.',
  },
  {
    name: 'notifyCashbackCredited',
    channel: 'orders',
    description:
      'Fires on every fulfilled order with userCashbackMinor > 0 (ADR 009). Distinct from notifyOrderFulfilled so the "cashback handed out" signal stays separate from the broader fulfillment stream.',
  },
  {
    name: 'notifyCashbackRecycled',
    channel: 'orders',
    description:
      'Fires when a new loop-native order is paid with LOOP-asset cashback the user earned earlier (ADR 015 flywheel). Subset qualifier on notifyOrderCreated — same channel so ops reads volume + flywheel-close together.',
  },
  {
    name: 'notifyFirstCashbackRecycled',
    channel: 'orders',
    description:
      "Fires once per user, on their FIRST loop_asset order — the flywheel-onboarding milestone (ADR 015). Subset of notifyCashbackRecycled; same channel so ops sees the user's graduation from earning → recycling alongside the continuing-recycle signal.",
  },
  {
    name: 'notifyOrderCreated',
    channel: 'orders',
    description: 'Fires on every new loop-native order (ADR 010). Embed lists merchant + amount.',
  },
  {
    name: 'notifyOrderFulfilled',
    channel: 'orders',
    description:
      'Fires when an order transitions to `fulfilled` — the user got their gift card. Complement to the orders-created signal above.',
  },
  {
    name: 'notifyAssetDrift',
    channel: 'monitoring',
    description:
      'Fires when a LOOP asset drifts past the operator threshold — on-chain circulation vs off-chain ledger liability (ADR 015). In-memory dedupe: fires once on ok→over, once on over→ok via notifyAssetDriftRecovered.',
  },
  {
    name: 'notifyAssetDriftRecovered',
    channel: 'monitoring',
    description:
      'Fires once per asset on the over→ok transition paired with notifyAssetDrift. Closes the drift incident in the channel so ops reads a beginning AND end for every alert.',
  },
  {
    name: 'notifyCircuitBreaker',
    channel: 'monitoring',
    description:
      'Fires when the upstream-CTX circuit breaker transitions open or closed (ADR 013 pool health).',
  },
  {
    name: 'notifyOperatorPoolExhausted',
    channel: 'monitoring',
    description:
      'Fires when every operator in the CTX pool is unhealthy — procurement is blocked. Throttled to once per 15 min per deployment so a sustained outage stays loud without flooding the channel (ADR 013).',
  },
  {
    name: 'notifyCtxSchemaDrift',
    channel: 'monitoring',
    description:
      'A2-1915: fires when an upstream CTX response fails Zod validation on a surface with a recorded contract fixture (A2-1706). Runtime companion to the PR-time contract test. Per-surface 10-min dedup so sustained drift produces one alert per surface per ten minutes, not one per failed request.',
  },
  {
    name: 'notifyHealthChange',
    channel: 'monitoring',
    description:
      'Fires on the /health probe cache transitioning healthy ↔ degraded. Paging-grade for the on-call lookup.',
  },
  {
    name: 'notifyPayoutFailed',
    channel: 'monitoring',
    description:
      'Fires when a pending_payouts row flips to `failed` (ADR 015/016). Embed carries asset code + user id + lastError preview.',
  },
  {
    name: 'notifyStuckProcurementSwept',
    channel: 'monitoring',
    description:
      'Fires when the sweep flips a stuck `procuring` order to `failed` (A2-621). Per-row so ops can reconcile individually — each row might be a CTX-minted-but-we-lost-track case where refunding the user would double-spend.',
  },
  {
    name: 'notifyPaymentWatcherStuck',
    channel: 'monitoring',
    description:
      "Fires when the payment watcher's Horizon cursor has not advanced in >10 min (A2-626). Catches crashed / hung tickers that would otherwise silently stop processing deposits. One-shot per stuck period.",
  },
  {
    name: 'notifyUsdcBelowFloor',
    channel: 'monitoring',
    description:
      "Fires when Loop's USDC operator balance drops below the alerting floor — time to fund the treasury account before payouts can't clear (ADR 015).",
  },
  {
    name: 'notifyWebhookPing',
    channel: 'monitoring',
    description:
      'Manual test ping from an admin — proves a channel is wired up after rotating the webhook env var. Sent on demand from /api/admin/discord/test; never fires automatically.',
  },
]);
