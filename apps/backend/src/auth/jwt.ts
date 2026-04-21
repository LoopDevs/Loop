/**
 * Bearer-token introspection. Decodes the payload of a JWT without
 * verifying its signature — we don't hold CTX's signing key, and any
 * mutation we make is guarded by a `requireAuth` that delegates to
 * CTX on every authed proxy call. If the bearer is forged, CTX
 * rejects downstream; the local decode only serves to extract the
 * user identifier (`sub`) so we can attach ledger state to the
 * right user row.
 *
 * A malformed / truncated / non-JWT string resolves to `null` rather
 * than throwing — callers should treat that as a 401.
 */

interface JwtPayload {
  sub: string;
  email?: string;
  [k: string]: unknown;
}

/**
 * Returns the decoded JWT payload, or `null` if the token can't be
 * parsed as a JWT. Never verifies the signature.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload] = parts;
  if (payload === undefined || payload.length === 0) return null;
  try {
    // base64url → base64 → utf-8 JSON. Node's Buffer handles
    // `base64url` natively from v16; using it avoids a manual
    // replace/pad dance.
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['sub'] !== 'string' || obj['sub'].length === 0) return null;
    const out: JwtPayload = { sub: obj['sub'], ...obj };
    return out;
  } catch {
    return null;
  }
}
