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
 * - path containing `..` segments (traversal)
 * - path containing control characters `\r\n\t\0` etc. (CRLF injection)
 */
export function upstreamUrl(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`upstreamUrl: path must start with '/', got ${JSON.stringify(path)}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('upstreamUrl: path contains control characters');
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) {
    throw new Error('upstreamUrl: path contains traversal segments');
  }
  const base = env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}
