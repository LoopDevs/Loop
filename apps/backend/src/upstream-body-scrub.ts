// A2-555, A2-1306, A4-083: redact secrets, emails, and card-shape substrings from upstream response bodies before logging

const JWT_RE = /[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const OPAQUE_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b\d{13,19}\b/g;
// A4-083: Stellar addresses partially match OPAQUE_TOKEN_RE; pinning prefix prevents loss if threshold changes
const STELLAR_PUBKEY_RE = /\bG[A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
// A4-083: Discord webhook URL is a high-impact secret if leaked
const DISCORD_WEBHOOK_RE = /\bhttps?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;

export function scrubUpstreamBody(body: string, maxLen = 500): string {
  if (body.length === 0) return body;
  try {
    const scrubbed = body
      // A4-083: Stellar + Discord first so they replace BEFORE OPAQUE_TOKEN_RE consumes the partially-overlapping 56-char Stellar address
      .replace(DISCORD_WEBHOOK_RE, '[REDACTED_DISCORD_WEBHOOK]')
      .replace(STELLAR_SECRET_RE, '[REDACTED_STELLAR_SECRET]')
      .replace(STELLAR_PUBKEY_RE, '[REDACTED_STELLAR_PUBKEY]')
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(OPAQUE_TOKEN_RE, '[REDACTED_TOKEN]')
      .replace(EMAIL_RE, '[REDACTED_EMAIL]')
      .replace(CARD_RE, '[REDACTED_CARD]');
    return scrubbed.length > maxLen ? scrubbed.slice(0, maxLen) : scrubbed;
  } catch {
    // Regex engine blowup on a pathological body — fall back to the naive slice so the handler's error branch doesn't mask the upstream failure with a scrubber error.
    return body.slice(0, maxLen);
  }
}
