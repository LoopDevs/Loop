import { env } from './env.js';
import { getCurrentRequestId, setCtxResponseRequestId } from './request-context.js';

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

/**
 * `fetch` for the CTX-proxy routes (auth, orders, merchants,
 * clustering), carrying the A2-1305 request-id correlation in both
 * directions:
 *
 *   - outbound: stamps our ambient `X-Request-Id` onto the CTX call so
 *     CTX logs their handling against our id. A caller that sets the
 *     header explicitly wins — it is assumed to know what it's doing.
 *     Only attached inside a real request (a boot-time sync or a
 *     scheduled worker has no ambient context).
 *   - inbound: captures CTX's own `X-Request-Id` — or `X-Correlation-Id`,
 *     depending on which CTX edge served the response — into the
 *     per-request store, where the post-handler middleware reads it and
 *     echoes it to the client as `X-Ctx-Request-Id`.
 *
 * `ctx/api-fetch.ts::ctxFetch` is the API-key-authenticated sibling for
 * server-to-server calls: it builds the credential headers and its own
 * timeout, then dispatches through here, so the correlation lives in
 * one place for both paths.
 *
 * Timeouts are the caller's job — every proxy call site passes its own
 * `AbortSignal.timeout(...)` sized to that endpoint.
 */
export async function upstreamFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const requestId = getCurrentRequestId();
  let outboundInit = init;
  if (requestId !== undefined) {
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Request-Id')) {
      headers.set('X-Request-Id', requestId);
      outboundInit = { ...init, headers };
    }
  }

  const response = await fetch(url, outboundInit);

  const ctxId = response.headers.get('X-Request-Id') ?? response.headers.get('X-Correlation-Id');
  if (ctxId !== null && ctxId.length > 0) {
    setCtxResponseRequestId(ctxId);
  }

  return response;
}
