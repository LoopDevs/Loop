// Loop JWT HS256 signer — ADR 030
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

export class Hs256Signer {
  readonly alg = 'HS256' as const;
  constructor(private readonly key: string) {}
  sign(signingInput: string): Buffer {
    return createHmac('sha256', this.key).update(signingInput).digest();
  }
  verify(signingInput: string, signatureBuf: Buffer): boolean {
    const expected = this.sign(signingInput);
    return expected.length === signatureBuf.length && timingSafeEqual(expected, signatureBuf);
  }
}

export function getActiveSigner(): Hs256Signer | null {
  const current = config.auth.native.jwt.current;
  if (current !== undefined && current.length > 0) {
    return new Hs256Signer(current);
  }
  return null;
}

// current key first, then previous rotation key
export function getVerifiers(): readonly Hs256Signer[] {
  const out: Hs256Signer[] = [];
  const { current, previous } = config.auth.native.jwt;
  if (current !== undefined && current.length > 0) {
    out.push(new Hs256Signer(current));
  }
  if (previous !== undefined && previous.length > 0) {
    out.push(new Hs256Signer(previous));
  }
  return out;
}

export function isAnySignerConfigured(): boolean {
  return getActiveSigner() !== null;
}
