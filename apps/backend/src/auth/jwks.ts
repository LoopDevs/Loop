/**
 * Provider-agnostic JWKS fetch + cache (ADR 014).
 *
 * Lifted out of `./id-token.ts`. Both Google and Apple publish their
 * id_token signing keys at a `/.well-known/jwks.json` URL and rotate
 * periodically. This module owns the fetch + per-URL TTL cache; the
 * verifier in `./id-token.ts` consumes the cached `Jwk[]` and does
 * the signature + claim work.
 *
 * Schema-drift on the JWKS response is a hard error: if a provider's
 * shape changes we refuse to verify rather than silently fall back to
 * an empty key set (which would make every id_token look unverified).
 *
 * Re-exported from `./id-token.ts` so existing import sites keep
 * resolving against the historical path.
 */
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ area: 'id-token' });

/** Shape of a single JWK we care about — RSA signing key. */
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

/** Per-URL JWKS cache. Google rotates every few hours; Apple less often. */
const jwksCache = new Map<string, CacheEntry>();

/** Test seam — forgets cached JWKS so the next call re-fetches. */
export function __resetJwksCacheForTests(): void {
  jwksCache.clear();
}

/**
 * Drops one URL's cached JWKS so the next `fetchJwks(url)` re-pulls.
 * Used by the verifier when an id_token's `kid` isn't in the cached
 * key set — the provider may have just rotated, and a single forced
 * refetch is cheaper than 60 minutes of failed verifies.
 */
export function invalidateJwks(url: string): void {
  jwksCache.delete(url);
}

/**
 * Fetches the JWKS from `url`, respecting an in-process cache with
 * a 1h TTL (ADR 014 — cache, don't pin). Schema-drift on the JWKS
 * response is a hard error: if the provider's shape changes, we
 * refuse to verify rather than silently fall back to an empty key
 * set (which would make every id_token look unverified).
 */
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
