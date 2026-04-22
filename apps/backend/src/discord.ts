import { env } from './env.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'discord' });

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

/**
 * Discord embed field values have a 1024-char cap and descriptions a 4096-char
 * cap. Truncating here means upstream data that happens to contain a giant
 * string (e.g. a stack trace passed into `details`) won't cause Discord to
 * reject the entire webhook with 400.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Escapes characters that Discord interprets as markdown or code-fence syntax.
 * Merchant names, order IDs, etc. are upstream-sourced — a value containing
 * backticks or underscores would otherwise break the embed's formatting.
 */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_~|>])/g, '\\$1');
}

/** Sends a message to a Discord webhook. Fails silently — never blocks app logic. */
async function sendWebhook(webhookUrl: string | undefined, embed: DiscordEmbed): Promise<void> {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }],
        // Discord webhooks default to parsing @everyone/@here/@user mentions
        // out of message content AND embed fields. A merchant or order field
        // containing `@everyone` would ping the whole channel. Explicitly
        // setting `parse: []` suppresses every mention type. Our embeds
        // never need to ping anyone, so this is a pure safety setting.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    // Discord returns 204 on success, 400 for malformed payloads, 429 if
    // we've hit the per-webhook rate limit. Log bad statuses so we notice
    // schema drift or accidental webhook flooding before ops does. Include
    // a truncated body so schema-drift debugging doesn't require reproducing.
    if (!response.ok) {
      let body = '';
      try {
        body = (await response.text()).slice(0, 500);
      } catch {
        /* body unreadable */
      }
      log.warn({ status: response.status, body }, 'Discord webhook returned non-success status');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to send Discord notification');
  }
}

// Colors
const GREEN = 3066993;
const RED = 15158332;
const ORANGE = 16753920;
const BLUE = 3447003;

// Discord field-value cap per API docs.
const FIELD_VALUE_MAX = 1024;
const DESCRIPTION_MAX = 4096;

/**
 * Format an amount for display. The previous code always prefixed `$`
 * regardless of currency, producing nonsense like "$25.00 EUR". Use the
 * currency-specific symbol when we know it, otherwise fall back to the
 * currency code on its own (e.g. "25.00 GBP"). Deliberately narrow
 * mapping — anything not in this table falls back to the safe format.
 */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$' };
function formatAmount(amount: number, currency: string): string {
  const code = escapeMarkdown(currency);
  const body = amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol !== undefined ? `${symbol}${body} ${code}` : `${body} ${code}`;
}

/** Notify: new order created */
export function notifyOrderCreated(
  orderId: string,
  merchantName: string,
  amount: number,
  currency: string,
  xlmAmount: string,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '🛒 New Order',
    color: BLUE,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(amount, currency), inline: true },
      { name: 'XLM', value: truncate(escapeMarkdown(xlmAmount), FIELD_VALUE_MAX), inline: true },
      { name: 'Order ID', value: `\`${escapeMarkdown(orderId)}\``, inline: false },
    ],
  });
}

/** Notify: order fulfilled (gift card ready) */
export function notifyOrderFulfilled(
  orderId: string,
  merchantName: string,
  amount: number,
  currency: string,
  redeemType: string,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '✅ Order Fulfilled',
    color: GREEN,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(amount, currency), inline: true },
      {
        name: 'Redeem',
        value: truncate(escapeMarkdown(redeemType), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(orderId)}\``, inline: false },
    ],
  });
}

/** Notify: health status changed */
export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

/**
 * Notify: an outbound Stellar payout has transitioned to `failed`
 * (ADR 015/016). Pages the monitoring channel so ops sees it
 * real-time rather than discovering failed rows on the next
 * admin-treasury refresh. The `kind` (from PayoutSubmitError) tells
 * ops whether it's an ops-actionable issue (op_no_trust,
 * op_underfunded) or a retry-exhausted transient — the former
 * often needs the user to add a trustline, the latter is a cue to
 * check Horizon / operator reserves.
 */
export function notifyPayoutFailed(args: {
  payoutId: string;
  userId: string;
  orderId: string;
  assetCode: string;
  amount: string;
  kind: string;
  reason: string;
  attempts: number;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stellar Payout Failed',
    color: RED,
    fields: [
      { name: 'Kind', value: `\`${escapeMarkdown(args.kind)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Amount', value: escapeMarkdown(args.amount), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'User', value: `\`${escapeMarkdown(args.userId)}\``, inline: true },
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId)}\``, inline: true },
      { name: 'Payout ID', value: `\`${escapeMarkdown(args.payoutId)}\``, inline: false },
      {
        name: 'Reason',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * Notify: operator USDC balance has dropped below the configured
 * floor (ADR 015). Procurement is now paying CTX in XLM until the
 * reserve is topped up. Ops needs to know because XLM is the
 * break-glass rail — we're burning the (smaller) XLM reserve to
 * keep orders flowing and the USDC pile isn't earning defindex
 * yield while it's empty.
 *
 * Throttled at the caller (once per `LOOP_BELOW_FLOOR_ALERT_INTERVAL_MS`
 * per process) — this function itself fires every time.
 */
export function notifyUsdcBelowFloor(args: {
  balanceStroops: string;
  floorStroops: string;
  account: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 USDC Reserve Below Floor',
    description: truncate(
      `Procurement has fallen back to XLM. Top up ${escapeMarkdown(args.account)} with USDC to re-enable the yield-earning path.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Balance (stroops)', value: escapeMarkdown(args.balanceStroops), inline: true },
      { name: 'Floor (stroops)', value: escapeMarkdown(args.floorStroops), inline: true },
    ],
  });
}

/**
 * Notify: admin write action (ADR 017/018). Called fire-and-forget
 * AFTER the DB commit of every admin mutation. Actor id truncated to
 * the last 8 chars so the embed doesn't expose a full uuid; full id
 * is still in the ledger for audit.
 */
export function notifyAdminAudit(args: {
  actorUserId: string;
  actorEmail: string;
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
    { name: 'Actor', value: `\`${actorTail}\` ${escapeMarkdown(args.actorEmail)}`, inline: true },
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

/** Notify: circuit breaker state change */
export function notifyCircuitBreaker(
  state: 'open' | 'closed',
  consecutiveFailures: number,
  cooldownSeconds = 30,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `Upstream API unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for ${cooldownSeconds}s.`
        : 'Upstream API recovered. Normal operation resumed.',
    color: state === 'open' ? RED : GREEN,
  });
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
    name: 'notifyCircuitBreaker',
    channel: 'monitoring',
    description:
      'Fires when the upstream-CTX circuit breaker transitions open or closed (ADR 013 pool health).',
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
    name: 'notifyUsdcBelowFloor',
    channel: 'monitoring',
    description:
      "Fires when Loop's USDC operator balance drops below the alerting floor — time to fund the treasury account before payouts can't clear (ADR 015).",
  },
]);
