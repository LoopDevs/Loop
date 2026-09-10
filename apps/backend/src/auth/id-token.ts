// provider-agnostic JWKS id_token verifier — ADR 014, A2-567, A2-569, A4-084
import { createHash } from 'node:crypto';
import { fetchJwks, invalidateJwks, type Jwk } from './jwks.js';
import { verifyWithKey } from './id-token-verify-with-key.js';

export { fetchJwks, type Jwk, __resetJwksCacheForTests } from './jwks.js';

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  email?: string;
  email_verified?: boolean;
  is_private_email?: string | boolean;
  [k: string]: unknown;
}

export interface VerifyIdTokenArgs {
  token: string;
  jwksUrl: string;
  expectedIssuers: string[];
  expectedAudiences: string[];
  now?: number;
  leewaySeconds?: number;
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
  | 'not_yet_valid'
  | 'iat_future'
  | 'lifetime_exceeded'
  | 'schema';

export type VerifyIdTokenResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: VerifyIdTokenError };

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
    // A4-084: invalidateJwks debounces per-URL; skip retry if in window to prevent JWKS endpoint thrashing
    const refetched = invalidateJwks(args.jwksUrl);
    if (!refetched) return { ok: false, reason: 'unknown_kid' };
    const refreshed = await fetchJwks(args.jwksUrl);
    const retry = refreshed.find((k) => k.kid === header.kid);
    if (retry === undefined) return { ok: false, reason: 'unknown_kid' };
    return verifyWithKey(retry, args, headerB64, payloadB64, sigB64);
  }
  return verifyWithKey(jwk, args, headerB64, payloadB64, sigB64);
}

export function jwkFingerprint(jwk: Pick<Jwk, 'n'>): string {
  return createHash('sha256').update(jwk.n, 'utf8').digest('hex').slice(0, 16);
}
