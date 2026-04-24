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
  try {
    const body = (await response.json()) as unknown;
    if (body !== null && typeof body === 'object') {
      const b = body as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        requestId?: unknown;
      };
      return {
        code: typeof b.code === 'string' ? b.code : 'UPSTREAM_ERROR',
        message: typeof b.message === 'string' ? b.message : response.statusText,
        ...(b.details !== undefined && typeof b.details === 'object' && b.details !== null
          ? { details: b.details as Record<string, unknown> }
          : {}),
        ...(typeof b.requestId === 'string' ? { requestId: b.requestId } : {}),
      };
    }
  } catch {
    // fall through to the UPSTREAM_ERROR fallback below
  }
  return { code: 'UPSTREAM_ERROR', message: response.statusText };
}
