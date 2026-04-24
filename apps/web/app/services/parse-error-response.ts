import type { ApiError } from '@loop/shared';

/**
 * Coerce a non-ok fetch `Response` into an `ApiError`.
 *
 * Closes A2-1162. `api-client.ts` and `clusters.ts` carried the
 * same body-shape-coerce logic byte-for-byte — a hard-to-notice
 * drift surface. Extracted once so every service wrapper shares
 * the same behaviour.
 *
 * Why the coercion is defensive: upstream / backend errors are
 * expected to be `{ code, message }`, but proxies, intermediate
 * gateways, and misconfigured servers can return anything — HTML
 * error pages, empty bodies, or JSON without our fields. Without
 * this normalisation, `ApiException.code` would be `undefined`,
 * breaking every `switch (err.code)` in downstream code.
 */
export async function parseErrorResponse(response: Response): Promise<ApiError> {
  // A2-1323: the `X-Request-Id` response header is stable across every
  // backend response (Hono's requestId() middleware stamps it). Body
  // `requestId` is opportunistic — only the catch-all 500 handler
  // attaches it. Read the header up front so the thrown ApiException
  // always carries the correlation id, even when the body didn't.
  const headerRequestId = response.headers.get('X-Request-Id') ?? undefined;
  try {
    const body = (await response.json()) as unknown;
    if (body !== null && typeof body === 'object') {
      const b = body as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        requestId?: unknown;
      };
      const bodyRequestId = typeof b.requestId === 'string' ? b.requestId : undefined;
      return {
        code: typeof b.code === 'string' ? b.code : 'UPSTREAM_ERROR',
        message: typeof b.message === 'string' ? b.message : response.statusText,
        ...(b.details !== undefined && typeof b.details === 'object' && b.details !== null
          ? { details: b.details as Record<string, unknown> }
          : {}),
        // Body wins if present (older backends that attach it to the
        // body match the header anyway); header is the stable fallback.
        ...(bodyRequestId !== undefined
          ? { requestId: bodyRequestId }
          : headerRequestId !== undefined
            ? { requestId: headerRequestId }
            : {}),
      };
    }
  } catch {
    // fall through to the UPSTREAM_ERROR fallback below
  }
  return {
    code: 'UPSTREAM_ERROR',
    message: response.statusText,
    ...(headerRequestId !== undefined ? { requestId: headerRequestId } : {}),
  };
}
