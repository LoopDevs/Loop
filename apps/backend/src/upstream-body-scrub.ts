/**
 * A2-555 + A2-1306: redact secrets, emails, and card-shape substrings
 * from upstream response bodies before logging them.
 *
 * Multiple handlers log truncated upstream bodies (`text().slice(0, 500)`)
 * when an upstream request fails, for schema-drift debugging. Pino's
 * redaction only matches structured field names — a body string
 * containing `"Invalid token eyJ...xyz"` or `"user alice@example.com
 * not found"` or `"card 4111111111111111 rejected"` slips through
 * verbatim. This scrubber catches the three shapes that most often
 * land in CTX / gift-card-provider error bodies.
 *
 * Patterns:
 *
 * - **JWT** (A2-555) — three base64url segments separated by dots.
 *   Each segment is at least 4 chars in practice (header is always
 *   `{"alg":...}`), so we require 4+ chars per segment to reduce false
 *   positives on IP-adjacent strings like `1.2.3`.
 * - **Opaque token** (A2-555) — a run of 32+ base64url chars that
 *   isn't already claimed by the JWT pattern.
 * - **Email** (A2-1306) — `local@host.tld` shape. Hostname must be
 *   dotted so we don't false-positive on Twitter handles or common
 *   `@someone` strings.
 * - **Card shape** (A2-1306) — 13-19 consecutive digits, matching
 *   the standard PAN / gift-card-code length range. Luhn check is
 *   skipped — cost isn't worth it for a logging scrubber, and false
 *   positives on long numeric ids are acceptable collateral.
 *
 * Each pattern is tagged in the replacement so an operator reading
 * the log can still tell WHAT was redacted even if they can't see it.
 */

const JWT_RE = /[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const OPAQUE_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b\d{13,19}\b/g;
// A4-083: explicit Stellar-address + secret patterns. Public keys
// are 'G' + 55 base32 chars (uppercase A-Z and 2-7); secrets are
// 'S' + 55 base32 chars. Both partially match OPAQUE_TOKEN_RE
// today (length≥32, alpha-and-digit), but the match is incidental
// — if we ever shorten OPAQUE_TOKEN_RE's threshold we'd lose them.
// Pinning the prefix here is also clearer in the redacted log.
const STELLAR_PUBKEY_RE = /\bG[A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
// A4-083: Discord webhook URL — high-impact secret if leaked
// (anyone with the URL can post to the channel). Format:
// https://discord(app)?.com/api/webhooks/<id>/<token>.
const DISCORD_WEBHOOK_RE = /\bhttps?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;

/**
 * Returns a copy of `body` with JWT-shaped, long opaque-token,
 * email, and card-shape substrings replaced. Safe on arbitrary
 * strings; never throws.
 *
 * Cap the result at the same 500-char length callers already use so
 * the redaction can't accidentally grow the log line.
 *
 * Replacement order matters: JWT runs first (longest, most specific),
 * then the opaque-token run, then email + card which are disjoint
 * from both.
 */
export function scrubUpstreamBody(body: string, maxLen = 500): string {
  if (body.length === 0) return body;
  try {
    const scrubbed = body
      // A4-083: Stellar + Discord first so they replace BEFORE
      // OPAQUE_TOKEN_RE consumes the partially-overlapping
      // 56-char Stellar address. Discord webhook tokens are
      // structurally inside the URL — replace as a unit.
      .replace(DISCORD_WEBHOOK_RE, '[REDACTED_DISCORD_WEBHOOK]')
      .replace(STELLAR_SECRET_RE, '[REDACTED_STELLAR_SECRET]')
      .replace(STELLAR_PUBKEY_RE, '[REDACTED_STELLAR_PUBKEY]')
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(OPAQUE_TOKEN_RE, '[REDACTED_TOKEN]')
      .replace(EMAIL_RE, '[REDACTED_EMAIL]')
      .replace(CARD_RE, '[REDACTED_CARD]');
    return scrubbed.length > maxLen ? scrubbed.slice(0, maxLen) : scrubbed;
  } catch {
    // Regex engine blowup on a pathological body — fall back to the
    // naive slice so the handler's error branch doesn't mask the
    // upstream failure with a scrubber error.
    return body.slice(0, maxLen);
  }
}
