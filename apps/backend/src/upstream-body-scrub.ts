/**
 * A2-555: redact JWT-shaped substrings from upstream response bodies
 * before logging them.
 *
 * Multiple handlers log truncated upstream bodies (`text().slice(0, 500)`)
 * when an upstream request fails, for schema-drift debugging. Pino's
 * redaction only matches structured field names — a body string
 * containing `"Invalid token eyJ...xyz"` slips through verbatim.
 *
 * A JWT is three base64url segments separated by dots. Each segment
 * is at least 4 chars in practice (header is always `{"alg":...}`),
 * so we require 4+ chars per segment to reduce false positives on
 * IP-adjacent strings like `1.2.3`.
 *
 * Also redacts obvious opaque token shapes: long base64url strings
 * 32+ chars long that aren't JWTs. Call these out as
 * `[REDACTED_TOKEN]` so operators still see the string was redacted.
 */

const JWT_RE = /[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const OPAQUE_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Returns a copy of `body` with JWT-shaped and long opaque-token
 * substrings replaced. Safe on arbitrary strings; never throws.
 *
 * Cap the result at the same 500-char length callers already use so
 * the redaction can't accidentally grow the log line.
 */
export function scrubUpstreamBody(body: string, maxLen = 500): string {
  if (body.length === 0) return body;
  try {
    const scrubbed = body
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(OPAQUE_TOKEN_RE, '[REDACTED_TOKEN]');
    return scrubbed.length > maxLen ? scrubbed.slice(0, maxLen) : scrubbed;
  } catch {
    // Regex engine blowup on a pathological body — fall back to the
    // naive slice so the handler's error branch doesn't mask the
    // upstream failure with a scrubber error.
    return body.slice(0, maxLen);
  }
}
