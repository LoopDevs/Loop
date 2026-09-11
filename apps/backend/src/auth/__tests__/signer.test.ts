import { describe, it, expect, vi } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { createHmac } from 'node:crypto';

// `signer.ts` reads keys lazily inside getActiveSigner(), so a plain mutable mock state object works.
const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    current: 'jwt-test-signing-key-32-chars-min!!' as string | undefined,
    previous: undefined as string | undefined,
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: true, jwt: jwtState },
        },
      };
    },
  };
});

import { getActiveSigner, getVerifiers, isAnySignerConfigured } from '../signer.js';

describe('signer', () => {
  describe('getActiveSigner', () => {
    it('returns an HS256 signer when auth.native.jwt.current is set', () => {
      const s = getActiveSigner();
      expect(s).not.toBeNull();
      expect(s?.alg).toBe('HS256');
    });

    it('round-trips a sign + verify under HS256', () => {
      const s = getActiveSigner();
      if (s === null) throw new Error('expected signer');
      const sig = s.sign('header.payload');
      expect(sig.length).toBe(32);
      expect(s.verify('header.payload', sig)).toBe(true);
    });

    it('rejects a tampered signature under HS256', () => {
      const s = getActiveSigner();
      if (s === null) throw new Error('expected signer');
      const sig = s.sign('header.payload');
      const tampered = Buffer.concat([sig.subarray(0, sig.length - 1), Buffer.from([0])]);
      // Flip the last byte if it was already 0x00 to ensure the signature differs.
      const finalTampered =
        Buffer.compare(tampered, sig) === 0
          ? Buffer.concat([sig.subarray(0, sig.length - 1), Buffer.from([1])])
          : tampered;
      expect(s.verify('header.payload', finalTampered)).toBe(false);
    });

    it("matches Node's native HMAC-SHA256 over the same key + input", () => {
      const s = getActiveSigner();
      if (s === null) throw new Error('expected signer');
      const ours = s.sign('foo.bar');
      const native = createHmac('sha256', 'jwt-test-signing-key-32-chars-min!!')
        .update('foo.bar')
        .digest();
      expect(Buffer.compare(ours, native)).toBe(0);
    });
  });

  describe('getVerifiers', () => {
    it('returns the current key as a verifier when auth.native.jwt.current is set', () => {
      const verifiers = getVerifiers();
      expect(verifiers.length).toBeGreaterThanOrEqual(1);
      expect(verifiers[0]?.alg).toBe('HS256');
    });

    it('returns BOTH current and previous keys during a rotation window', () => {
      // The mock re-reads `jwtState` on every access, so setting the previous slot here is sufficient.
      jwtState.current = 'jwt-test-current-signing-key-32min!!';
      jwtState.previous = 'jwt-test-signing-key-previous-32chr!';
      try {
        const verifiers = getVerifiers();
        expect(verifiers.length).toBe(2);
        expect(verifiers.every((v) => v.alg === 'HS256')).toBe(true);
      } finally {
        jwtState.current = 'jwt-test-signing-key-32-chars-min!!';
        jwtState.previous = undefined;
      }
    });
  });

  describe('isAnySignerConfigured', () => {
    it('returns true when the signing key is present', () => {
      expect(isAnySignerConfigured()).toBe(true);
    });
  });
});
