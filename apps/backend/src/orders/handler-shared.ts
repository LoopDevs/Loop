// shared CTX-proxy helpers — A2-1915, A2-1706
import type { Context } from 'hono';
import { z } from 'zod';
import type { ZodIssue } from 'zod';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/require-auth.js';
import { getUserCtxUserId } from '../db/users.js';
import { ctxActAsHeaders } from '../ctx/user-provisioning.js';

const log = logger.child({ handler: 'orders' });

// A2-1915
export function summariseZodIssues(issues: readonly ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.path.join('.') || '·'}] ${i.code}: ${i.message}`)
    .join(' | ');
}

// Loop JWT is not forwardable to CTX; act-as requires X-User-Id to avoid exposing operator data.
export async function upstreamHeaders(c: Context): Promise<Record<string, string> | null> {
  const clientId = c.get('clientId') as string | undefined;
  const auth = c.get('auth') as LoopAuthContext | undefined;

  if (auth?.kind === 'loop') {
    const ctxUserId = await getUserCtxUserId(auth.userId);
    return ctxActAsHeaders(ctxUserId, clientId);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.get('bearerToken') as string}`,
  };
  if (clientId) {
    headers['X-Client-Id'] = clientId;
  }
  return headers;
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
