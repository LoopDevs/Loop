// Discord webhook infrastructure — A2-2004, A2-1306, A2-1522, MNY-05
import { logger } from '../logger.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';

const log = logger.child({ module: 'discord' });

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\u2066-\u2069\uFEFF]/g;

// A2-2004
export function escapeMarkdown(value: string): string {
  return value.replace(BIDI_AND_ZERO_WIDTH, '').replace(/([\\`*_~|>[\]()])/g, '\\$1');
}

let warnedUnconfigured = false;

// Test hook
export function __resetUnconfiguredWebhookWarningForTests(): void {
  warnedUnconfigured = false;
}

export async function sendWebhook(
  webhookUrl: string | undefined,
  embed: DiscordEmbed,
): Promise<boolean> {
  if (!webhookUrl) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      log.warn(
        'Discord webhook URL is not configured — notifications are being dropped, not delivered (set observability.discord.* to enable alerting)',
      );
    }
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      let body = '';
      try {
        body = scrubUpstreamBody(await response.text());
      } catch {
        /* body unreadable */
      }
      log.warn({ status: response.status, body }, 'Discord webhook returned non-success status');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err }, 'Failed to send Discord notification');
    return false;
  }
}

export const GREEN = 3066993;
export const RED = 15158332;
export const ORANGE = 16753920;
export const BLUE = 3447003;

export const FIELD_VALUE_MAX = 1024;
export const DESCRIPTION_MAX = 4096;

export function formatAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const symbol = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value;
    const body = amount.toFixed(2);
    if (symbol !== undefined) {
      return `${escapeMarkdown(symbol)}${body} ${escapeMarkdown(code)}`;
    }
    return `${body} ${escapeMarkdown(code)}`;
  } catch {
    return `${amount.toFixed(2)} ${escapeMarkdown(code)}`;
  }
}

export function formatMinorAmount(minorStr: string, currency: string): string {
  const code = currency.toUpperCase();
  let minor: bigint;
  try {
    minor = BigInt(minorStr);
  } catch {
    return `${escapeMarkdown(minorStr)} ${escapeMarkdown(code)}`;
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const sign = negative ? '-' : '';
  const wholeWithSeparators = new Intl.NumberFormat('en-US').format(whole);
  const body = `${wholeWithSeparators}.${fraction}`;

  let symbol: string | undefined;
  try {
    symbol = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value;
  } catch {
    symbol = undefined;
  }
  if (symbol !== undefined) {
    return `${sign}${escapeMarkdown(symbol)}${body} ${escapeMarkdown(code)}`;
  }
  return `${sign}${body} ${escapeMarkdown(code)}`;
}
