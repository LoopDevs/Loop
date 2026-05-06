/**
 * Pluggable JWT signer abstraction (Tranche-2 prep — ADR 030 Track A.1).
 *
 * Today Loop signs every JWT with HS256 + a shared secret. ADR 030
 * targets a Privy-integration migration to RS256 with a JWKS publish
 * endpoint at `/.well-known/jwks.json` so Privy's Custom Auth Provider
 * can verify Loop's tokens without sharing the signing key.
 *
 * This module decouples the algorithm choice from `tokens.ts`'s
 * sign/verify entry points so the swap is mechanical when Track A.2
 * lands. The HS256 path is the only concrete implementation today;
 * the `Alg` union already carries `'RS256'` so the dispatch in
 * `tokens.ts::verifyLoopToken` can route on it, but `Rs256Signer`
 * isn't built until Track A.2 needs it.
 *
 * Verification dispatches on the JWT header's `alg` field — during a
 * future HS256 → RS256 rotation, both algorithms must verify since
 * 15-minute access tokens minted under the old algorithm survive
 * past the cutover.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export type Alg = 'HS256' | 'RS256';

export interface Signer {
  readonly alg: Alg;
  /**
   * `kid` for JWKS lookup — required for RS256 (multiple keys in
   * the JWKS), absent for HS256 (single secret, no per-key id).
   */
  readonly kid?: string;
  sign(signingInput: string): Buffer;
  verify(signingInput: string, signatureBuf: Buffer): boolean;
}

class Hs256Signer implements Signer {
  readonly alg: 'HS256' = 'HS256';
  constructor(private readonly key: string) {}
  sign(signingInput: string): Buffer {
    return createHmac('sha256', this.key).update(signingInput).digest();
  }
  verify(signingInput: string, signatureBuf: Buffer): boolean {
    const expected = this.sign(signingInput);
    return expected.length === signatureBuf.length && timingSafeEqual(expected, signatureBuf);
  }
}

// Track A.2 will add an `Rs256Signer implements Signer` class right
// here — `createSign('RSA-SHA256')` for sign, `createVerify(...)` for
// verify, with a `KeyObject` pair + `kid` from the
// `LOOP_JWT_PRIVATE_KEY` family. Not landing it now keeps A.1 a pure
// abstraction with no inert code; the `Alg` union below carries the
// 'RS256' value so the dispatch in `tokens.ts::verifyLoopToken` can
// already case on it.

/**
 * Returns the signer that newly-issued tokens should use. `null` when
 * Loop-native auth is unconfigured (no signing key in env). Callers
 * treat null as "Loop-native auth disabled" and fall through to the
 * legacy CTX-proxy path.
 *
 * Track A.2 will extend this to prefer RS256 over HS256 when the
 * `LOOP_JWT_PRIVATE_KEY` family is set, leaving HS256 as the
 * historical fallback during rotation.
 */
export function getActiveSigner(): Signer | null {
  if (typeof env.LOOP_JWT_SIGNING_KEY === 'string' && env.LOOP_JWT_SIGNING_KEY.length > 0) {
    return new Hs256Signer(env.LOOP_JWT_SIGNING_KEY);
  }
  return null;
}

/**
 * Returns the set of signers that can verify a token under the given
 * `alg`. Multiple HS256 keys exist during a rotation window
 * (`LOOP_JWT_SIGNING_KEY` + `LOOP_JWT_SIGNING_KEY_PREVIOUS`); the
 * caller iterates and accepts the first match. Track A.2 adds RS256
 * with kid lookup against the JWKS-published public keys.
 */
export function getVerifiersForAlg(alg: Alg): readonly Signer[] {
  if (alg === 'HS256') {
    const out: Signer[] = [];
    if (typeof env.LOOP_JWT_SIGNING_KEY === 'string' && env.LOOP_JWT_SIGNING_KEY.length > 0) {
      out.push(new Hs256Signer(env.LOOP_JWT_SIGNING_KEY));
    }
    if (
      typeof env.LOOP_JWT_SIGNING_KEY_PREVIOUS === 'string' &&
      env.LOOP_JWT_SIGNING_KEY_PREVIOUS.length > 0
    ) {
      out.push(new Hs256Signer(env.LOOP_JWT_SIGNING_KEY_PREVIOUS));
    }
    return out;
  }
  // Track A.2 fills the RS256 path with JWKS lookup + kid match.
  return [];
}

/**
 * True when at least one signer is configured (any algorithm). Public
 * API used by `auth/native.ts`, `auth/require-auth.ts`,
 * `auth/logout-handler.ts`, `auth/social.ts` to gate Loop-native flows
 * on auth being available.
 */
export function isAnySignerConfigured(): boolean {
  return getActiveSigner() !== null;
}
