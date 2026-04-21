/**
 * Loop-signed JWT sign + verify (ADR 013).
 *
 * Minted by Loop against `LOOP_JWT_SIGNING_KEY` (HS256). Kept
 * dependency-free on Node's built-in `crypto` — the token format is
 * narrow (always HS256, always our claim shape) so pulling in
 * `jsonwebtoken` or `jose` would carry surface area we don't need.
 *
 * Verification accepts either the current key or
 * `LOOP_JWT_SIGNING_KEY_PREVIOUS` so a rotation can overlap for the
 * access-token TTL without a flag-day.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '../env.js';

export type TokenType = 'access' | 'refresh';

export interface LoopTokenClaims {
  sub: string;
  email: string;
  typ: TokenType;
  iat: number;
  exp: number;
  // Refresh-token opaque id — lets us revoke an individual refresh
  // without invalidating the whole key. Access tokens omit this.
  jti?: string;
}

export interface SignOptions {
  sub: string;
  email: string;
  typ: TokenType;
  ttlSeconds: number;
  /** Override `now` for tests; seconds since epoch. */
  now?: number;
  /** Optional jti (refresh tokens). Generated if omitted. */
  jti?: string;
}

const ACCESS_TTL_SECONDS = 15 * 60; // 15 min
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const DEFAULT_ACCESS_TTL_SECONDS = ACCESS_TTL_SECONDS;
export const DEFAULT_REFRESH_TTL_SECONDS = REFRESH_TTL_SECONDS;

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function hmac(key: string, signingInput: string): Buffer {
  return createHmac('sha256', key).update(signingInput).digest();
}

function currentKey(): string {
  const k = env.LOOP_JWT_SIGNING_KEY;
  if (k === undefined) {
    throw new Error('LOOP_JWT_SIGNING_KEY is not configured — Loop-native auth is disabled');
  }
  return k;
}

/**
 * Signs a Loop JWT. Caller supplies the type + TTL; this module owns
 * the claim shape. `iat` is pinned to the provided `now` (or `Date.now()`)
 * so tests are deterministic.
 */
export function signLoopToken(opts: SignOptions): { token: string; claims: LoopTokenClaims } {
  const key = currentKey();
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: LoopTokenClaims = {
    sub: opts.sub,
    email: opts.email,
    typ: opts.typ,
    iat: nowSec,
    exp: nowSec + opts.ttlSeconds,
  };
  if (opts.typ === 'refresh') {
    // 16 random bytes → 22-char base64url. Enough entropy to survive
    // a straight-up brute force of the revocation table.
    claims.jti = opts.jti ?? randomBytes(16).toString('base64url');
  }
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = b64urlEncode(hmac(key, signingInput));
  return { token: `${signingInput}.${sig}`, claims };
}

export type VerifyResult =
  | { ok: true; claims: LoopTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_type' };

/**
 * Verifies a Loop JWT. Checks signature against the current key first,
 * then the previous key (rotation window). Does NOT check the token is
 * in a revocation list — callers doing revocation must do that
 * themselves (refresh tokens go through `refresh_tokens` table).
 *
 * `expectedType` narrows to one of `access` or `refresh`. A token of
 * the wrong type against an endpoint expecting the other returns
 * `wrong_type` — defends against a stolen refresh being replayed on
 * a data endpoint, or an access being used as a refresh.
 */
export function verifyLoopToken(token: string, expectedType: TokenType): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, providedSig] = parts;
  if (
    header === undefined ||
    payload === undefined ||
    providedSig === undefined ||
    header.length === 0 ||
    payload.length === 0 ||
    providedSig.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const signingInput = `${header}.${payload}`;
  const providedSigBuf = b64urlDecode(providedSig);
  const keys = [env.LOOP_JWT_SIGNING_KEY, env.LOOP_JWT_SIGNING_KEY_PREVIOUS].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  if (keys.length === 0) return { ok: false, reason: 'bad_signature' };
  const matched = keys.some((k) => {
    const expected = hmac(k, signingInput);
    return expected.length === providedSigBuf.length && timingSafeEqual(expected, providedSigBuf);
  });
  if (!matched) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['sub'] !== 'string' ||
    typeof obj['email'] !== 'string' ||
    (obj['typ'] !== 'access' && obj['typ'] !== 'refresh') ||
    typeof obj['iat'] !== 'number' ||
    typeof obj['exp'] !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (obj['typ'] !== expectedType) {
    return { ok: false, reason: 'wrong_type' };
  }
  if (obj['exp'] < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  const claims: LoopTokenClaims = {
    sub: obj['sub'],
    email: obj['email'],
    typ: obj['typ'],
    iat: obj['iat'],
    exp: obj['exp'],
  };
  if (typeof obj['jti'] === 'string') claims.jti = obj['jti'];
  return { ok: true, claims };
}

/** True when `LOOP_JWT_SIGNING_KEY` is configured. */
export function isLoopAuthConfigured(): boolean {
  return typeof env.LOOP_JWT_SIGNING_KEY === 'string' && env.LOOP_JWT_SIGNING_KEY.length > 0;
}
