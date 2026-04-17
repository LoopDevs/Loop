import { env } from './env.js';

/**
 * Builds a full URL to the upstream CTX API.
 *
 * The `path` is inserted verbatim after the base URL. Validation here is a
 * defense-in-depth layer: callers are expected to validate user input at the
 * request boundary (e.g. orders/handler.ts enforces `^[\w-]+$` on orderId
 * before interpolation), but centralizing the check means a future caller
 * that forgets cannot silently introduce path traversal or CRLF injection.
 *
 * Throws on:
 * - path without a leading `/` (programmer error)
 * - path with a leading `//` (protocol-relative URL / scheme confusion)
 * - path containing `..` segments — raw or percent-encoded (traversal)
 * - path containing control characters `\r\n\t\0` etc. (CRLF injection),
 *   including the C1 range (0x80–0x9f)
 */
export function upstreamUrl(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`upstreamUrl: path must start with '/', got ${JSON.stringify(path)}`);
  }
  // Reject protocol-relative shape (`//host/...`). `new URL(base + '//evil')`
  // can resolve to a different host than intended depending on parser
  // behaviour. We never need this, so forbid it outright.
  if (path.startsWith('//')) {
    throw new Error('upstreamUrl: path must not start with // (protocol-relative)');
  }
  // C0 controls (0x00–0x1f), DEL (0x7f), and C1 controls (0x80–0x9f). The C0
  // range covers CR/LF/NUL used in header-injection / request-smuggling; C1
  // is rare in practice but cheap to include and HTTP intermediaries handle
  // it inconsistently.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error('upstreamUrl: path contains control characters');
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) {
    throw new Error('upstreamUrl: path contains traversal segments');
  }
  // Percent-encoded traversal: `%2e%2e` (case-insensitive) is `..` after
  // the upstream decodes. Some proxies normalise the path before routing;
  // rejecting the encoded form here means the attacker can't smuggle a
  // traversal past our raw-form check.
  if (/%2e%2e/i.test(path)) {
    throw new Error('upstreamUrl: path contains percent-encoded traversal segments');
  }
  const base = env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}
