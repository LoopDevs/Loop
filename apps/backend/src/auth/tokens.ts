// Loop-signed JWT sign + verify — ADR 013, ADR 030, A2-1600, NS-09
import { randomBytes } from 'node:crypto';
import { getActiveSigner, getVerifiers, isAnySignerConfigured } from './signer.js';

export type TokenType = 'access' | 'refresh';

// A2-1600: exact-match check; no suffix/wildcard logic
export const LOOP_JWT_ISSUER = 'loop-api';

// Paired with iss to reject tokens minted for a different service
export const LOOP_JWT_AUDIENCE = 'loop-clients';

export interface LoopTokenClaims {
  sub: string;
  email: string;
  typ: TokenType;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  // Opaque id for individual revocation without invalidating the whole key
  jti?: string;
  // NS-09: snapshot of users.token_version at mint time. requireAuth compares to current row value; absence fails closed.
  tv?: number;
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
  /**
   * NS-09: token-version to stamp as the `tv` claim (ACCESS tokens).
   * The caller passes the user's current `users.token_version`; omit
   * for refresh tokens (they revoke via their DB row).
   */
  tv?: number;
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

export function signLoopToken(opts: SignOptions): { token: string; claims: LoopTokenClaims } {
  const signer = getActiveSigner();
  if (signer === null) {
    throw new Error(
      'No Loop JWT signing key configured (auth.native.jwt.current) — Loop-native auth is disabled',
    );
  }
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: LoopTokenClaims = {
    sub: opts.sub,
    email: opts.email,
    typ: opts.typ,
    iat: nowSec,
    exp: nowSec + opts.ttlSeconds,
    iss: LOOP_JWT_ISSUER,
    aud: LOOP_JWT_AUDIENCE,
  };
  if (opts.typ === 'refresh') {
    // 16 random bytes → 22-char base64url. Enough entropy to survive
    // a straight-up brute force of the revocation table.
    claims.jti = opts.jti ?? randomBytes(16).toString('base64url');
  }
  // NS-09: stamp the token-version snapshot when supplied (access
  // tokens). Kept out of the refresh branch by the caller — refresh
  // tokens revoke via their `refresh_tokens` row, not `tv`.
  if (opts.tv !== undefined) {
    claims.tv = opts.tv;
  }
  const header = b64urlEncode(JSON.stringify({ alg: signer.alg, typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = b64urlEncode(signer.sign(signingInput));
  return { token: `${signingInput}.${sig}`, claims };
}

export type VerifyResult =
  | { ok: true; claims: LoopTokenClaims }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'bad_signature'
        | 'expired'
        | 'wrong_type'
        | 'wrong_issuer'
        | 'wrong_audience';
    };

// Does NOT check revocation lists; callers must handle that themselves.
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

  // Reject any alg other than HS256 (alg-strip / confusion defence)
  let headerObj: unknown;
  try {
    headerObj = JSON.parse(b64urlDecode(header).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (headerObj === null || typeof headerObj !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const alg = (headerObj as Record<string, unknown>)['alg'];
  if (alg !== 'HS256') {
    return { ok: false, reason: 'bad_signature' };
  }
  const verifiers = getVerifiers();
  if (verifiers.length === 0) return { ok: false, reason: 'bad_signature' };

  const signingInput = `${header}.${payload}`;
  const providedSigBuf = b64urlDecode(providedSig);
  const matched = verifiers.some((s) => s.verify(signingInput, providedSigBuf));
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
    typeof obj['exp'] !== 'number' ||
    typeof obj['iss'] !== 'string' ||
    typeof obj['aud'] !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (obj['typ'] !== expectedType) {
    return { ok: false, reason: 'wrong_type' };
  }
  if (obj['exp'] < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  // A2-1600: dedicated reason codes distinguish cross-service replay from malformed tokens
  if (obj['iss'] !== LOOP_JWT_ISSUER) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  if (obj['aud'] !== LOOP_JWT_AUDIENCE) {
    return { ok: false, reason: 'wrong_audience' };
  }
  const claims: LoopTokenClaims = {
    sub: obj['sub'],
    email: obj['email'],
    typ: obj['typ'],
    iat: obj['iat'],
    exp: obj['exp'],
    iss: obj['iss'],
    aud: obj['aud'],
  };
  if (typeof obj['jti'] === 'string') claims.jti = obj['jti'];
  // NS-09: surface tv for requireAuth comparison; verify stays pure (no DB)
  if (typeof obj['tv'] === 'number') claims.tv = obj['tv'];
  return { ok: true, claims };
}

export function isLoopAuthConfigured(): boolean {
  return isAnySignerConfigured();
}
