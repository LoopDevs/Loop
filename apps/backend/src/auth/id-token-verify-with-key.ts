/**
 * id_token signature + claim verification, given a chosen JWK
 * (ADR 014).
 *
 * Lifted out of `./id-token.ts`. The parent `verifyIdToken` does
 * the orchestration — splits the token, decodes the header, looks
 * up the JWKS, retries on unknown kid — and then hands the chosen
 * key + the three encoded segments to this function for the actual
 * verification: import the JWK, RSA-SHA256 verify the signature,
 * parse the payload, run all the claim-shape and time-bound checks
 * (iss / aud / exp / iat / nbf / lifetime, with clock-skew leeway).
 *
 * Pulling it out leaves the parent file focused on the lookup +
 * retry + error-mapping concerns; the crypto + claim-shape side
 * carries one direction of responsibility per file.
 *
 * Re-exported is unnecessary — `verifyWithKey` is module-private
 * to the parent today, and the lifted version stays the same shape:
 * called from `./id-token.ts` directly via `import`.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { logger } from '../logger.js';
import type { Jwk } from './jwks.js';
import type { IdTokenClaims, VerifyIdTokenArgs, VerifyIdTokenResult } from './id-token.js';

const log = logger.child({ area: 'id-token' });

export function verifyWithKey(
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
