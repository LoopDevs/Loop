/**
 * Pluggable JWT signer abstraction (ADR 030 Phase A — Track A.1
 * shipped the abstraction, Track A.2 shipped RS256).
 *
 * Two concrete signers:
 *
 * - `Rs256Signer` — preferred when `auth.native.jwt.rs256.current`
 *   (PKCS8 PEM, boot-validated by the config schema) is configured.
 *   Newly-minted Loop
 *   JWTs sign RS256 with a `kid` header (RFC 7638 SHA-256 JWK
 *   thumbprint of the public key) so an external wallet provider
 *   (Privy Custom Auth, or any JWKS-consuming verifier — ADR 030)
 *   can verify Loop's tokens against `/.well-known/jwks.json`
 *   without Loop sharing a secret.
 * - `Hs256Signer` — the legacy shared-secret path
 *   (`auth.native.jwt.hs256.current`). Still the active signer when no
 *   RSA key is configured (rollout safety), and always available as a
 *   verifier while the HS256 keys remain set so outstanding tokens
 *   survive the HS256 → RS256 cutover window.
 *
 * Verification dispatches on the JWT header's `alg` field — during
 * the HS256 → RS256 cutover, both algorithms verify since 15-minute
 * access tokens (and 30-day refresh tokens) minted under the old
 * algorithm survive past the cutover. Within an algorithm the
 * current key is tried before the `_PREVIOUS` rotation key.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { config } from '../config/index.js';

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

/**
 * Public half of an RSA signing key in standard JWK shape (RFC 7517
 * §4 + RFC 7518 §6.3.1). Exactly the six public members — never any
 * private-key material (`d`, `p`, `q`, `dp`, `dq`, `qi`) — because
 * this shape is served verbatim at `/.well-known/jwks.json`.
 */
export interface LoopRsaPublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  alg: 'RS256';
  use: 'sig';
  kid: string;
}

class Rs256Signer implements Signer {
  readonly alg: 'RS256' = 'RS256';
  readonly kid: string;
  /** Public JWK served at /.well-known/jwks.json. */
  readonly publicJwk: LoopRsaPublicJwk;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(privateKeyPem: string) {
    // The config schema boot-validates the PEM (parse +
    // asymmetricKeyType check),
    // so a throw here means the module was driven with an unvalidated
    // value — fail loudly rather than mint unverifiable tokens.
    this.privateKey = createPrivateKey(privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error(
        `Rs256Signer requires an RSA private key, got ${this.privateKey.asymmetricKeyType ?? 'unknown'}`,
      );
    }
    this.publicKey = createPublicKey(this.privateKey);
    const jwk = this.publicKey.export({ format: 'jwk' }) as {
      kty?: unknown;
      n?: unknown;
      e?: unknown;
    };
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
      throw new Error('Rs256Signer: public-key JWK export missing RSA members (kty/n/e)');
    }
    // RFC 7638 §3.1 JWK thumbprint: SHA-256 over the JSON of ONLY the
    // required RSA public members ({e, kty, n}), keys in lexicographic
    // order, no whitespace — exactly what JSON.stringify of this
    // literal produces. Stable across processes/deploys for the same
    // key, so external verifiers can cache by kid.
    this.kid = createHash('sha256')
      .update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }))
      .digest('base64url');
    this.publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: this.kid };
  }

  sign(signingInput: string): Buffer {
    // RSASSA-PKCS1-v1_5 with SHA-256 — the JWA `RS256` algorithm
    // (RFC 7518 §3.3). Node's default padding for RSA sign.
    return createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
  }

  verify(signingInput: string, signatureBuf: Buffer): boolean {
    return createVerify('RSA-SHA256').update(signingInput).verify(this.publicKey, signatureBuf);
  }
}

/**
 * Per-PEM memo for Rs256Signer construction. PEM parse + thumbprint
 * hashing is pure but not free; the env values are static for the
 * process lifetime so at most two entries ever exist (current +
 * previous). Tests that mutate env go through `vi.resetModules()`,
 * which discards this cache with the module.
 */
const rs256SignerCache = new Map<string, Rs256Signer>();

function rs256SignerFor(privateKeyPem: string): Rs256Signer {
  let signer = rs256SignerCache.get(privateKeyPem);
  if (signer === undefined) {
    signer = new Rs256Signer(privateKeyPem);
    rs256SignerCache.set(privateKeyPem, signer);
  }
  return signer;
}

/**
 * Returns the signer that newly-issued tokens should use. `null` when
 * Loop-native auth is unconfigured (no signing key). Callers treat
 * null as "Loop-native auth disabled" and fall through to the legacy
 * CTX-proxy path.
 *
 * RS256 (`auth.native.jwt.rs256.current`) is preferred over HS256 when
 * both are configured — the cutover is "set the RSA key"; the HS256
 * key stays set (verification only) until outstanding HS256 tokens
 * expire (ADR 030 Phase A; runbook: docs/runbooks/jwt-key-rotation.md).
 */
export function getActiveSigner(): Signer | null {
  if (
    typeof config.auth.native.jwt.rs256.current === 'string' &&
    config.auth.native.jwt.rs256.current.length > 0
  ) {
    return rs256SignerFor(config.auth.native.jwt.rs256.current);
  }
  if (
    typeof config.auth.native.jwt.hs256.current === 'string' &&
    config.auth.native.jwt.hs256.current.length > 0
  ) {
    return new Hs256Signer(config.auth.native.jwt.hs256.current);
  }
  return null;
}

/**
 * Returns the set of signers that can verify a token under the given
 * `alg`, current key first, the `previous` rotation key second; the
 * caller iterates and accepts the first match. Combined with the
 * alg dispatch in `tokens.ts::verifyLoopToken`, the effective verify
 * order across the migration window is: RS256 current → RS256
 * previous (for RS256-headed tokens), then HS256 current → HS256
 * previous (for legacy HS256-headed tokens).
 */
export function getVerifiersForAlg(alg: Alg): readonly Signer[] {
  if (alg === 'HS256') {
    const out: Signer[] = [];
    if (
      typeof config.auth.native.jwt.hs256.current === 'string' &&
      config.auth.native.jwt.hs256.current.length > 0
    ) {
      out.push(new Hs256Signer(config.auth.native.jwt.hs256.current));
    }
    if (
      typeof config.auth.native.jwt.hs256.previous === 'string' &&
      config.auth.native.jwt.hs256.previous.length > 0
    ) {
      out.push(new Hs256Signer(config.auth.native.jwt.hs256.previous));
    }
    return out;
  }
  const out: Signer[] = [];
  if (
    typeof config.auth.native.jwt.rs256.current === 'string' &&
    config.auth.native.jwt.rs256.current.length > 0
  ) {
    out.push(rs256SignerFor(config.auth.native.jwt.rs256.current));
  }
  if (
    typeof config.auth.native.jwt.rs256.previous === 'string' &&
    config.auth.native.jwt.rs256.previous.length > 0
  ) {
    out.push(rs256SignerFor(config.auth.native.jwt.rs256.previous));
  }
  return out;
}

/**
 * Public JWKs for the configured RSA signing keys — current first,
 * then `previous` during a rotation window. Empty array when RS256
 * is unconfigured (the JWKS endpoint then serves a valid-but-empty
 * key set). Consumed by `auth/jwks-publish.ts`; contains public
 * members only by construction (see `LoopRsaPublicJwk`).
 */
export function getLoopRsaPublicJwks(): LoopRsaPublicJwk[] {
  const out: LoopRsaPublicJwk[] = [];
  if (
    typeof config.auth.native.jwt.rs256.current === 'string' &&
    config.auth.native.jwt.rs256.current.length > 0
  ) {
    out.push(rs256SignerFor(config.auth.native.jwt.rs256.current).publicJwk);
  }
  if (
    typeof config.auth.native.jwt.rs256.previous === 'string' &&
    config.auth.native.jwt.rs256.previous.length > 0
  ) {
    out.push(rs256SignerFor(config.auth.native.jwt.rs256.previous).publicJwk);
  }
  return out;
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
