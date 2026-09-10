// pluggable JWT signer — ADR 030
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

// public JWK shape — served verbatim at /.well-known/jwks.json
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
  readonly publicJwk: LoopRsaPublicJwk;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(privateKeyPem: string) {
    // config schema boot-validates PEM; throw here means unvalidated input — fail loudly
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
    // RFC 7638 §3.1 thumbprint: SHA-256 over {e, kty, n} in lexicographic order
    this.kid = createHash('sha256')
      .update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }))
      .digest('base64url');
    this.publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: this.kid };
  }

  sign(signingInput: string): Buffer {
    return createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
  }

  verify(signingInput: string, signatureBuf: Buffer): boolean {
    return createVerify('RSA-SHA256').update(signingInput).verify(this.publicKey, signatureBuf);
  }
}

// memoized per-PEM; env values static for process lifetime
const rs256SignerCache = new Map<string, Rs256Signer>();

function rs256SignerFor(privateKeyPem: string): Rs256Signer {
  let signer = rs256SignerCache.get(privateKeyPem);
  if (signer === undefined) {
    signer = new Rs256Signer(privateKeyPem);
    rs256SignerCache.set(privateKeyPem, signer);
  }
  return signer;
}

// RS256 preferred over HS256 when both configured — ADR 030
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

// current key first, then previous rotation key
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

// public JWKs for JWKS endpoint; empty array when RS256 unconfigured
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

export function isAnySignerConfigured(): boolean {
  return getActiveSigner() !== null;
}
