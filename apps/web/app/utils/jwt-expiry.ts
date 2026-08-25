/**
 * Client-side JWT expiry inspection.
 *
 * Both token issuers the client can face emit JWTs with a numeric
 * `exp` claim — Loop-native access/refresh pairs (HS256/RS256,
 * `apps/backend/src/auth/tokens.ts`) and CTX pairs in proxy mode
 * (RS256, 8h access / long-lived refresh). That makes expiry a
 * client-decodable fact, so the auth layer can roll tokens
 * proactively instead of burning a guaranteed-401 round trip, and
 * can skip the refresh call entirely when both tokens are dead.
 *
 * Decode-only — NO signature verification, and none is wanted here:
 * the client holds tokens it was handed by the backend, and the only
 * question is "is it worth sending". The backend remains the
 * authority; an undecodable or exp-less token is treated as
 * NOT-known-expired (fail open) so the existing 401 → refresh →
 * retry path stays the backstop.
 */

/**
 * Freshness margin. A token expiring inside this window is treated
 * as already expired — a request stamped with it would likely age
 * out in flight (clock skew + network latency).
 */
export const JWT_EXPIRY_SKEW_MS = 30_000;

/** Decoded `exp` in epoch-ms, or null when absent / undecodable. */
export function getJwtExpiryMs(token: string): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    // base64url → base64. atob is fine here: JWT payloads are ASCII
    // JSON and every target runtime (browser + Capacitor WebView)
    // has it.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(b64));
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as Record<string, unknown>)['exp'];
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * True only when the token carries a decodable `exp` that has passed
 * (or falls inside the skew window). Opaque / exp-less tokens return
 * false — "not known to be expired" — so callers still attempt them
 * and rely on the server's 401 as the authority.
 */
export function isJwtExpired(token: string, skewMs: number = JWT_EXPIRY_SKEW_MS): boolean {
  const expiryMs = getJwtExpiryMs(token);
  if (expiryMs === null) return false;
  return expiryMs <= Date.now() + skewMs;
}
