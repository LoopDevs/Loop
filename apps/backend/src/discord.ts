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

/** Sends a message to a Discord webhook. Fails silently — never blocks app logic. */
async function sendWebhook(webhookUrl: string | undefined, embed: DiscordEmbed): Promise<void> {
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    log.warn({ err }, 'Failed to send Discord notification');
  }
}

// Colors
const GREEN = 3066993;
const RED = 15158332;
const ORANGE = 16753920;
const BLUE = 3447003;

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
      { name: 'Merchant', value: merchantName, inline: true },
      { name: 'Amount', value: `$${amount.toFixed(2)} ${currency}`, inline: true },
      { name: 'XLM', value: xlmAmount, inline: true },
      { name: 'Order ID', value: `\`${orderId}\``, inline: false },
    ],
  });
}

/** Notify: order fulfilled (gift card ready) */
export function notifyOrderFulfilled(
  orderId: string,
  merchantName: string,
  amount: number,
  redeemType: string,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '✅ Order Fulfilled',
    color: GREEN,
    fields: [
      { name: 'Merchant', value: merchantName, inline: true },
      { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: true },
      { name: 'Redeem', value: redeemType, inline: true },
      { name: 'Order ID', value: `\`${orderId}\``, inline: false },
    ],
  });
}

/** Notify: health status changed */
export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: details,
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

/** Notify: circuit breaker state change */
export function notifyCircuitBreaker(state: 'open' | 'closed', consecutiveFailures: number): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `Upstream API unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for 30s.`
        : 'Upstream API recovered. Normal operation resumed.',
    color: state === 'open' ? RED : GREEN,
  });
}
