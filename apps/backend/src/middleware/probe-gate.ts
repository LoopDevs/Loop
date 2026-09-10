// Bearer-token guard for ops/observability probe endpoints — A2-1606, A2-1607
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Context } from 'hono';
import { config } from '../config/index.js';

export function probeGateAllows(c: Context, expected: string | undefined): boolean {
  if (expected === undefined) {
    return config.env !== 'production';
  }
  const header = c.req.header('Authorization');
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return false;
  const presented = match[1]!.trim();
  // timingSafeEqual throws on length mismatch; size-check first to avoid leaking "wrong length" vs "wrong byte"
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}
