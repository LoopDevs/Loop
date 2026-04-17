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
      }),
      signal: AbortSignal.timeout(5000),
    });
    // Discord returns 204 on success, 400 for malformed payloads, 429 if
    // we've hit the per-webhook rate limit. Log bad statuses so we notice
    // schema drift or accidental webhook flooding before ops does.
    if (!response.ok) {
      log.warn({ status: response.status }, 'Discord webhook returned non-success status');
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
      { name: 'Amount', value: `$${amount.toFixed(2)} ${escapeMarkdown(currency)}`, inline: true },
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
      { name: 'Amount', value: `$${amount.toFixed(2)} ${escapeMarkdown(currency)}`, inline: true },
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
