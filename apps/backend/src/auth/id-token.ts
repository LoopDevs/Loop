/**
 * Provider-agnostic JWKS-backed id_token verifier (ADR 014).
 *
 * Usable by both Google and Apple: each provider publishes a JWKS
 * at `/.well-known/jwks.json` (or similar), signs id_tokens with
 * RS256, and rotates keys periodically. The JWKS fetch + per-URL
 * TTL cache live in `./jwks.ts`; this file consumes the cached
 * `Jwk[]` and does the signature + claim verification.
 *
 * Dep-free — no `jose` / `@stellar/stellar-sdk` / etc. The surface
 * we need is narrow (one algorithm, a small claim set), and Node's
 * built-in `createPublicKey({ format: 'jwk' })` lets us import the
 * JWKS key material directly.
 */
import { createHash } from 'node:crypto';
import { fetchJwks, invalidateJwks, type Jwk } from './jwks.js';
import { verifyWithKey } from './id-token-verify-with-key.js';

// `fetchJwks` + the `Jwk` type + `__resetJwksCacheForTests` test
// seam live in `./jwks.ts`. Re-exported here so existing import
// sites against `'./id-token.js'` keep resolving.
export { fetchJwks, type Jwk, __resetJwksCacheForTests } from './jwks.js';

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  /**
   * A2-569: "not before" claim (RFC 7519). Optional — providers
   * rarely set it, but when present the token isn't valid before
   * this time. Checked with the same leeway as exp / iat.
   */
  nbf?: number;
  email?: string;
  email_verified?: boolean;
  /** Apple-specific — whether the email is a private relay. */
  is_private_email?: string | boolean;
  [k: string]: unknown;
}

export interface VerifyIdTokenArgs {
  token: string;
  jwksUrl: string;
  /**
   * A2-567: list of acceptable `iss` values. Verification accepts
   * any member — a token whose iss doesn't match any entry returns
   * `wrong_issuer`. See SocialProviderConfig for Google's two
   * documented variants.
   */
  expectedIssuers: string[];
  /** Set of acceptable audience values — usually one per platform. */
  expectedAudiences: string[];
  /** Override `Date.now()` for tests; seconds since epoch. */
  now?: number;
  /**
   * A2-569: clock-skew tolerance in seconds applied to every time-
   * bound check (`nbf`, `iat`, `exp`, lifetime). 60s matches typical
   * NTP drift + provider-clock variance; used by Google and Apple
   * verifier reference code. Tests can pass 0 for exact-boundary
   * assertions.
   */
  leewaySeconds?: number;
  /**
   * A2-569: upper bound on `exp - iat` (in seconds). A provider-
   * issued id_token lives ~1 hour in practice; a claim asserting
   * `exp - iat` > this cap is a forgery signal. Default 3600s (1h).
   */
  maxLifetimeSeconds?: number;
}

export type VerifyIdTokenError =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  // A2-569 — time-bound extensions:
  | 'not_yet_valid' // nbf > now + leeway
  | 'iat_future' // iat > now + leeway
  | 'lifetime_exceeded' // exp - iat > maxLifetimeSeconds
  | 'schema';

export type VerifyIdTokenResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: VerifyIdTokenError };

/**
 * Decodes (but doesn't verify) the JWT header. Used to look up the
 * right JWKS key by `kid` before running signature verification.
 */
function decodeHeader(token: string): { kid?: string; alg?: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const json = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    return {
      ...(typeof obj['kid'] === 'string' ? { kid: obj['kid'] } : {}),
      ...(typeof obj['alg'] === 'string' ? { alg: obj['alg'] } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Verifies an id_token end-to-end. Returns a tagged result so the
 * caller can map each reason to the right HTTP response (all reject
 * paths are 401 today, but differentiating helps with logging and
 * potential future UX differences).
 */
export async function verifyIdToken(args: VerifyIdTokenArgs): Promise<VerifyIdTokenResult> {
  const parts = args.token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts;
  if (
    headerB64 === undefined ||
    payloadB64 === undefined ||
    sigB64 === undefined ||
    headerB64.length === 0 ||
    payloadB64.length === 0 ||
    sigB64.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const header = decodeHeader(args.token);
  if (header === null) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  const keys = await fetchJwks(args.jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) {
    // Key not in cache — could be a recent rotation. Force refetch
    // once to catch up before giving up. Avoids a stuck-cache class
    // of incident.
    //
    // A4-084: invalidateJwks now debounces per-URL. If we're inside
    // the debounce window, skip the retry-refetch entirely — a
    // burst of unknown-kid attempts can't thrash the provider's
    // JWKS endpoint, and the cache will refresh naturally on its
    // 60-min TTL or via the next debounce-window invalidation.
    const refetched = invalidateJwks(args.jwksUrl);
    if (!refetched) return { ok: false, reason: 'unknown_kid' };
    const refreshed = await fetchJwks(args.jwksUrl);
    const retry = refreshed.find((k) => k.kid === header.kid);
    if (retry === undefined) return { ok: false, reason: 'unknown_kid' };
    return verifyWithKey(retry, args, headerB64, payloadB64, sigB64);
  }
  return verifyWithKey(jwk, args, headerB64, payloadB64, sigB64);
}

// `verifyWithKey` (the signature + claim-shape side, given a chosen
// JWK) lives in `./id-token-verify-with-key.ts`. Imported above; not
// re-exported because it was module-private to begin with.

/**
 * SHA-256 fingerprint of a JWK's `n` component. Useful for logging
 * + ops — operators can compare the fingerprint against the
 * provider's published key list without having to paste modulus
 * bytes around.
 */
export function jwkFingerprint(jwk: Pick<Jwk, 'n'>): string {
  return createHash('sha256').update(jwk.n, 'utf8').digest('hex').slice(0, 16);
}
