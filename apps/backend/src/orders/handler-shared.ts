/**
 * Shared CTX-proxy helpers used by `handler.ts`,
 * `list-handler.ts`, and `get-handler.ts`.
 *
 * Lifted out of `apps/backend/src/orders/handler.ts` so the
 * trio of read/write handlers all import these primitives from
 * a single sibling module instead of going via the create-handler
 * file:
 *
 *   - `summariseZodIssues(issues)` — one-line Discord-embed
 *     formatter for the A2-1915 schema-drift notifier.
 *   - `upstreamHeaders(c)` — builds the Authorization +
 *     X-Client-Id headers every CTX request needs.
 *   - `CreateOrderUpstreamResponse` — Zod schema for the CTX
 *     `POST /gift-cards` response (A2-1706: exported so the
 *     contract-test suite can validate recorded fixtures).
 *   - `ORDER_EXPIRY_SECONDS` — server-authoritative payment-window
 *     length. The client used to hardcode this; making the server
 *     authoritative removes clock-skew drift.
 *   - `mapStatus(ctxStatus)` — normalises upstream CTX status
 *     strings to our OrderStatus enum.
 *
 * Re-exported from `handler.ts` so the existing imports in
 * `list-handler.ts`, `get-handler.ts`, and the contract test
 * keep resolving unchanged.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { ZodIssue } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'orders' });

/**
 * A2-1915: condense a Zod issue array into a compact one-line
 * summary suitable for a Discord embed field. Used by the
 * `notifyCtxSchemaDrift` call sites in this module + auth +
 * merchants.
 */
export function summariseZodIssues(issues: readonly ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

/** Builds auth headers for upstream requests, including optional X-Client-Id. */
export function upstreamHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.get('bearerToken') as string}`,
  };
  const clientId = c.get('clientId') as string | undefined;
  if (clientId) {
    headers['X-Client-Id'] = clientId;
  }
  return headers;
}

// Upstream response schemas — validate before forwarding to client.
// A2-1706: exported so the contract-test suite can parse recorded
// CTX fixtures through them at PR-time and detect schema drift before
// it hits prod.
export const CreateOrderUpstreamResponse = z
  .object({
    id: z.string(),
    paymentCryptoAmount: z.string(),
    paymentUrls: z.record(z.string(), z.string()).optional(),
    status: z.string(),
  })
  .passthrough();

/**
 * Seconds the client should consider an order valid for payment. The client
 * used to hardcode this to now() + 30min, which drifted relative to the
 * server under any clock skew — the payment countdown could expire mid-pay or
 * show a bogus value. Now the server computes and returns the expiry, making
 * the backend authoritative for the payment window.
 *
 * If CTX starts returning its own expiry in the `/gift-cards` response we can
 * prefer that; for now the upstream schema doesn't surface one.
 */
export const ORDER_EXPIRY_SECONDS = 30 * 60;

/** Maps upstream CTX status values to our normalized OrderStatus. */
export function mapStatus(ctxStatus: string): 'pending' | 'completed' | 'failed' | 'expired' {
  if (ctxStatus === 'fulfilled') return 'completed';
  if (ctxStatus === 'expired') return 'expired';
  if (ctxStatus === 'refunded') return 'failed';
  const known = new Set(['unpaid', 'processing', 'paid', 'pending']);
  if (!known.has(ctxStatus)) {
    log.warn({ ctxStatus }, 'Unknown upstream order status — defaulting to pending');
  }
  return 'pending';
}
