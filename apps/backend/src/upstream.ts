import { config } from './config/index.js';
import { getCurrentRequestId, setCtxResponseRequestId } from './request-context.js';

// Defense-in-depth: rejects protocol-relative, control chars (C0/C1), and raw/encoded traversal to prevent injection/smuggling.
export function upstreamUrl(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`upstreamUrl: path must start with '/', got ${JSON.stringify(path)}`);
  }
  if (path.startsWith('//')) {
    throw new Error('upstreamUrl: path must not start with // (protocol-relative)');
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error('upstreamUrl: path contains control characters');
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) {
    throw new Error('upstreamUrl: path contains traversal segments');
  }
  if (/%2e%2e/i.test(path)) {
    throw new Error('upstreamUrl: path contains percent-encoded traversal segments');
  }
  const base = config.ctx.baseUrl.replace(/\/$/, '');
  return `${base}${path}`;
}

// Stamps ambient X-Request-Id outbound (A2-1305) and captures CTX's response ID for client echo.
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
