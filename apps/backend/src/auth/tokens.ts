/**
 * Loop-signed JWT sign + verify (ADR 013).
 *
 * Minted by Loop with the signer returned by
 * `./signer.ts::getActiveSigner()`. Today that's HS256 against
 * `LOOP_JWT_SIGNING_KEY`; ADR 030 Track A.2 will add RS256 with JWKS
 * publish so Privy's Custom Auth Provider can verify Loop's tokens.
 * The algorithm choice lives behind the Signer interface — this
 * module owns the JWT claim shape, header construction, and verify
 * dispatch.
 *
 * Verification reads `alg` from the incoming token's header and
 * fetches the matching set of verifiers; during an HS256 rotation
 * (`LOOP_JWT_SIGNING_KEY` + `LOOP_JWT_SIGNING_KEY_PREVIOUS`) both
 * keys are tried. During a future HS256 → RS256 cutover, both
 * algorithms verify so 15-minute access tokens minted under the old
 * algorithm don't get rejected post-cutover.
 */
import { randomBytes } from 'node:crypto';
import { getActiveSigner, getVerifiersForAlg, isAnySignerConfigured, type Alg } from './signer.js';

export type TokenType = 'access' | 'refresh';

/**
 * JWT `iss` (issuer) — identifies the minting service (A2-1600).
 * Fixed string so one Loop deployment's token cannot be accepted by
 * any other service that happens to share a key. Verification is an
 * exact-match check; no suffix / wildcard logic.
 */
export const LOOP_JWT_ISSUER = 'loop-api';

/**
 * JWT `aud` (audience) — identifies the resource server. Paired with
 * `iss`, this rejects tokens minted for a different service (e.g. a
 * social-login exchange accidentally replayed against the Loop API).
 */
export const LOOP_JWT_AUDIENCE = 'loop-clients';

export interface LoopTokenClaims {
  sub: string;
  email: string;
  typ: TokenType;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
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

/**
 * Signs a Loop JWT. Caller supplies the type + TTL; this module owns
 * the claim shape. `iat` is pinned to the provided `now` (or
 * `Date.now()`) so tests are deterministic. The header `alg` and
 * (where applicable) `kid` come from the active signer.
 */
export function signLoopToken(opts: SignOptions): { token: string; claims: LoopTokenClaims } {
  const signer = getActiveSigner();
  if (signer === null) {
    throw new Error('LOOP_JWT_SIGNING_KEY is not configured — Loop-native auth is disabled');
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
  const headerObj: Record<string, string> = { alg: signer.alg, typ: 'JWT' };
  if (signer.kid !== undefined) headerObj['kid'] = signer.kid;
  const header = b64urlEncode(JSON.stringify(headerObj));
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

/**
 * Verifies a Loop JWT. Reads the header's `alg` field, fetches the
 * matching set of verifiers, and tries each. Does NOT check the
 * token is in a revocation list — callers doing revocation must do
 * that themselves (refresh tokens go through `refresh_tokens` table).
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

  // Parse header to discover alg. Reject anything that doesn't match
  // a known algorithm — defends against `alg: 'none'` and unknown
  // algorithms that would otherwise route to an empty verifier set.
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
  if (alg !== 'HS256' && alg !== 'RS256') {
    return { ok: false, reason: 'bad_signature' };
  }
  const verifiers = getVerifiersForAlg(alg as Alg);
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
  // A2-1600: exact-match iss/aud. Rejecting here (not at malformed)
  // gives a dedicated reason code so ops can tell "token from a
  // different service" apart from "malformed / corrupt token".
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
  return { ok: true, claims };
}

/** True when an active signer is configured (any algorithm). */
export function isLoopAuthConfigured(): boolean {
  return isAnySignerConfigured();
}
