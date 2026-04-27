/**
 * Shared infrastructure for Discord webhook notifications. Pulled
 * out of `discord.ts` so per-channel notifier modules
 * (`./orders.ts`, future `./monitoring.ts`, `./admin-audit.ts`)
 * can import the primitives without depending on the entry-point
 * file.
 *
 * Three threat surfaces protected here (preserved verbatim from
 * the original):
 *
 *   1. **Markdown emphasis** (`*`, `_`, `~`, `|`, `>`, `\``) — a
 *      merchant name with a backtick would corrupt the embed; not
 *      a security issue but breaks ops readability.
 *   2. **Link construction** — Discord renders `[text](url)` as a
 *      clickable link. An attacker who controls a field
 *      (merchant name, reason, email address) can plant a
 *      deceptive link in the audit channel that looks benign but
 *      resolves to a phishing URL. Escape `[`, `]`, `(`, `)` so
 *      the syntax never reaches Discord's parser.
 *   3. **Bidi + zero-width control characters** — RTL overrides
 *      like `\u202E` flip rendering direction
 *      (`pa\u202Eytuoyap` looks like "payouytua" but actually
 *      contains "paytuoyap" reversed). Zero-width joiners hide
 *      characters entirely. Strip both ranges so an admin
 *      reviewing a Discord ping sees the literal bytes.
 *
 * The webhook send path also pins `allowed_mentions: { parse: [] }`
 * so `@everyone` / `@here` / `@user` in upstream-controlled
 * fields can't ping the channel.
 */
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

/**
 * Discord embed field values have a 1024-char cap and descriptions
 * a 4096-char cap. Truncating here means upstream data that
 * happens to contain a giant string (e.g. a stack trace passed
 * into `details`) won't cause Discord to reject the entire
 * webhook with 400.
 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\u2066-\u2069\uFEFF]/g;

/** A2-2004 — see `@file` jsdoc above for the threat-surface rationale. */
export function escapeMarkdown(value: string): string {
  return value.replace(BIDI_AND_ZERO_WIDTH, '').replace(/([\\`*_~|>[\]()])/g, '\\$1');
}

/** Sends a message to a Discord webhook. Fails silently — never blocks app logic. */
export async function sendWebhook(
  webhookUrl: string | undefined,
  embed: DiscordEmbed,
): Promise<void> {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }],
        // Discord webhooks default to parsing @everyone/@here/@user
        // mentions out of message content AND embed fields. A
        // merchant or order field containing `@everyone` would ping
        // the whole channel. Explicitly setting `parse: []`
        // suppresses every mention type. Our embeds never need to
        // ping anyone, so this is a pure safety setting.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    // Discord returns 204 on success, 400 for malformed payloads,
    // 429 if we've hit the per-webhook rate limit. Log bad statuses
    // so we notice schema drift or accidental webhook flooding
    // before ops does. Include a truncated body so schema-drift
    // debugging doesn't require reproducing.
    if (!response.ok) {
      let body = '';
      try {
        // A2-1306: scrub JWT / opaque-token / email / card
        // substrings before logging. Discord error bodies usually
        // echo the submitted payload back, which can include user
        // identifiers (email, IDs) that arrived from upstream
        // notifiers.
        body = scrubUpstreamBody(await response.text());
      } catch {
        /* body unreadable */
      }
      log.warn({ status: response.status, body }, 'Discord webhook returned non-success status');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to send Discord notification');
  }
}

// Embed colours.
export const GREEN = 3066993;
export const RED = 15158332;
export const ORANGE = 16753920;
export const BLUE = 3447003;

// Discord field-value cap per API docs.
export const FIELD_VALUE_MAX = 1024;
export const DESCRIPTION_MAX = 4096;

/**
 * A2-1522: format an amount using `Intl.NumberFormat` for the
 * symbol. The prior hardcoded 4-entry symbol map (USD/EUR/GBP/CAD)
 * drifted from the web's `Intl`-based formatter and produced
 * `"25.00 JPY"` instead of `"¥25"` for any fifth currency Loop
 * launched into.
 *
 * The output shape is `<narrowSymbol><amount> <CODE>` — the code
 * suffix keeps the embed unambiguous at a glance for ops even
 * when two currencies share a symbol (USD and CAD both render `$`,
 * several others use `Kr`, etc.). Intl picks the symbol, we still
 * append the code for clarity.
 */
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
    // Invalid currency code — fall back to the code-suffix form.
    return `${amount.toFixed(2)} ${escapeMarkdown(code)}`;
  }
}

/**
 * Minor-unit bigint-string → human currency. Mirrors the web's
 * `fmtMinor` but bigint-safe — a cashback of 250000 minor units
 * on a GBP order must render as £2,500.00, not lose precision
 * through a Number cast. Trailing 2 chars are always fractional
 * (we don't support 0/3-decimal currencies on Loop today).
 */
export function formatMinorAmount(minorStr: string, currency: string): string {
  // A2-1522: BigInt-safe minor-unit rendering with Intl for the
  // currency symbol. We do the 2-decimal split ourselves (so
  // cashback totals beyond JS's safe-integer range keep their
  // precision), then look up the symbol via Intl.
  const negative = minorStr.startsWith('-');
  const digits = negative ? minorStr.slice(1) : minorStr;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  const code = currency.toUpperCase();
  const wholeWithSeparators = Number(whole).toLocaleString('en-US');
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
