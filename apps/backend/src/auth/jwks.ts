// Provider-agnostic JWKS fetch + cache — ADR 014, A4-084
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'id-token' });

const Jwk = z.object({
  kid: z.string(),
  kty: z.literal('RSA'),
  n: z.string(),
  e: z.string(),
  alg: z.string().optional(),
});

const JwksResponse = z.object({
  keys: z.array(Jwk.passthrough()),
});

export type Jwk = z.infer<typeof Jwk>;

interface CacheEntry {
  keys: Jwk[];
  expiresAt: number;
}

const jwksCache = new Map<string, CacheEntry>();

export function __resetJwksCacheForTests(): void {
  jwksCache.clear();
}

// A4-084: debounce prevents unknown-kid tokens from forcing a refetch per attempt
const INVALIDATE_DEBOUNCE_MS = 60_000;
const lastInvalidatedAtMs = new Map<string, number>();

export function __resetJwksInvalidateDebounceForTests(): void {
  lastInvalidatedAtMs.clear();
}

export function invalidateJwks(url: string): boolean {
  const now = Date.now();
  const last = lastInvalidatedAtMs.get(url) ?? 0;
  if (now - last < INVALIDATE_DEBOUNCE_MS) return false;
  lastInvalidatedAtMs.set(url, now);
  jwksCache.delete(url);
  return true;
}

export async function fetchJwks(url: string, opts: { timeoutMs?: number } = {}): Promise<Jwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(url);
  if (cached !== undefined && cached.expiresAt > now) return cached.keys;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    log.error({ url, status: res.status }, 'JWKS fetch failed');
    throw new Error(`JWKS fetch ${res.status} for ${url}`);
  }
  const raw = await res.json();
  const parsed = JwksResponse.safeParse(raw);
  if (!parsed.success) {
    log.error({ url, issues: parsed.error.issues }, 'JWKS response failed schema');
    throw new Error(`JWKS schema drift at ${url}`);
  }
  const keys = parsed.data.keys;
  jwksCache.set(url, { keys, expiresAt: now + 60 * 60 * 1000 });
  return keys;
}
