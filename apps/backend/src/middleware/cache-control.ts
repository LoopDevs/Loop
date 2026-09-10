// Cache-Control middleware — mount before requireAuth so 401s also carry the header
import type { Context } from 'hono';

// no-store: prevents misconfigured proxies from serving one user's tokens to another
export async function noStoreResponse(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  c.header('Cache-Control', 'no-store');
}

// private, no-store: prevents CDN/proxy from serving one user's data to another
export async function privateNoStoreResponse(c: Context, next: () => Promise<void>): Promise<void> {
  await next();
  c.header('Cache-Control', 'private, no-store');
}
