/**
 * Provider-agnostic JWKS-backed id_token verifier (ADR 014).
 *
 * Usable by both Google and Apple: each provider publishes a JWKS
 * at `/.well-known/jwks.json` (or similar), signs id_tokens with
 * RS256, and rotates keys periodically. We fetch + cache the JWKS,
 * verify signatures with `node:crypto`, and enforce `iss` / `aud` /
 * `exp` / optional `email_verified`.
 *
 * Dep-free — no `jose` / `@stellar/stellar-sdk` / etc. The surface
 * we need is narrow (one algorithm, a small claim set), and Node's
 * built-in `createPublicKey({ format: 'jwk' })` lets us import the
 * JWKS key material directly.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
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
    jwksCache.delete(args.jwksUrl);
    const refreshed = await fetchJwks(args.jwksUrl);
    const retry = refreshed.find((k) => k.kid === header.kid);
    if (retry === undefined) return { ok: false, reason: 'unknown_kid' };
    return verifyWithKey(retry, args, headerB64, payloadB64, sigB64);
  }
  return verifyWithKey(jwk, args, headerB64, payloadB64, sigB64);
}

function verifyWithKey(
  jwk: Jwk,
  args: VerifyIdTokenArgs,
  headerB64: string,
  payloadB64: string,
  sigB64: string,
): VerifyIdTokenResult {
  let publicKey;
  try {
    publicKey = createPublicKey({ format: 'jwk', key: jwk as unknown as Record<string, unknown> });
  } catch (err) {
    log.error({ err, kid: jwk.kid }, 'JWK import failed');
    return { ok: false, reason: 'bad_signature' };
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = Buffer.from(sigB64, 'base64url');
  const verified = cryptoVerify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), publicKey, sigBuf);
  if (!verified) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'malformed' };
  const obj = parsed as Record<string, unknown>;

  if (
    typeof obj['iss'] !== 'string' ||
    typeof obj['sub'] !== 'string' ||
    typeof obj['aud'] !== 'string' ||
    typeof obj['exp'] !== 'number' ||
    typeof obj['iat'] !== 'number'
  ) {
    return { ok: false, reason: 'schema' };
  }

  if (!args.expectedIssuers.includes(obj['iss'])) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  if (!args.expectedAudiences.includes(obj['aud'])) {
    return { ok: false, reason: 'wrong_audience' };
  }
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const leeway = args.leewaySeconds ?? 60;
  const maxLifetime = args.maxLifetimeSeconds ?? 3600;
  const exp = obj['exp'];
  const iat = obj['iat'];

  // A2-569: tighter time-bound checks than the prior "exp < now" alone.
  // Every boundary tolerates `leeway` seconds of clock skew in the
  // safe direction (past for exp, future for nbf/iat).
  if (exp + leeway < now) {
    return { ok: false, reason: 'expired' };
  }
  if (iat > now + leeway) {
    // Future-dated issuance — either a severely-skewed provider
    // clock or a forgery. Reject; a legit client re-attempt after
    // clock sync will pass.
    return { ok: false, reason: 'iat_future' };
  }
  if (exp - iat > maxLifetime) {
    // id_token carrying a lifetime longer than providers ever issue
    // — Google caps at 1h, Apple at ~1h. A longer window is a
    // forgery signal (attacker-controlled signer pretending to be
    // the provider but setting their own expiry).
    return { ok: false, reason: 'lifetime_exceeded' };
  }
  // `nbf` is optional per RFC 7519; only enforce when present.
  const nbf = obj['nbf'];
  if (typeof nbf === 'number' && nbf > now + leeway) {
    return { ok: false, reason: 'not_yet_valid' };
  }

  return {
    ok: true,
    claims: obj as unknown as IdTokenClaims,
  };
}

/**
 * SHA-256 fingerprint of a JWK's `n` component. Useful for logging
 * + ops — operators can compare the fingerprint against the
 * provider's published key list without having to paste modulus
 * bytes around.
 */
export function jwkFingerprint(jwk: Pick<Jwk, 'n'>): string {
  return createHash('sha256').update(jwk.n, 'utf8').digest('hex').slice(0, 16);
}
