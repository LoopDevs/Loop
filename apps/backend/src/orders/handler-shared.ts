// shared CTX-proxy helpers — A2-1915, A2-1706
import type { Context } from 'hono';
import { z } from 'zod';
import type { ZodIssue } from 'zod';
import type { LoopAuthContext } from '../auth/require-auth.js';
import { ctxFetch } from '../ctx/api-fetch.js';

// A2-1915
export function summariseZodIssues(issues: readonly ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

// Loop JWT is not forwardable to CTX; act-as requires X-User-Id to avoid exposing operator data.
export function ctxProxyFetch(c: Context, url: string, init: RequestInit): Promise<Response> {
  const clientId = c.get('clientId') as string | undefined;
  const auth = c.get('auth') as LoopAuthContext;
  return ctxFetch(url, init, { actAs: { userId: auth.userId, clientId } });
}

// A2-1706
export const CreateOrderUpstreamResponse = z
  .object({
    id: z.string(),
    paymentCryptoAmount: z.string(),
    paymentUrls: z.record(z.string(), z.string()).optional(),
    status: z.string(),
  })
  .passthrough();

// Server-authoritative to prevent client clock-skew drift.
export const ORDER_EXPIRY_SECONDS = 30 * 60;

export function percentFromBasisPoints(basisPoints: number | undefined): string | undefined {
  if (basisPoints === undefined) return undefined;
  return (basisPoints / 100).toFixed(2);
}
