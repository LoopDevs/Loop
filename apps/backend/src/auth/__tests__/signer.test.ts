import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Set the signing key BEFORE env.ts is loaded — signer.ts reads env
// lazily inside getActiveSigner() but env.ts validates at import.
vi.hoisted(() => {
  process.env['LOOP_JWT_SIGNING_KEY'] = 's'.repeat(32);
});

import { getActiveSigner, getVerifiersForAlg, isAnySignerConfigured } from '../signer.js';

describe('signer (Tranche-2 prep — Track A.1)', () => {
  describe('getActiveSigner', () => {
    it('returns an HS256 signer when LOOP_JWT_SIGNING_KEY is set', () => {
      const s = getActiveSigner();
      expect(s).not.toBeNull();
      expect(s?.alg).toBe('HS256');
      // HS256 has no kid; the JWT header omits it accordingly.
      expect(s?.kid).toBeUndefined();
    });

    it('round-trips a sign + verify under HS256', () => {
      const s = getActiveSigner();
      if (s === null) throw new Error('expected signer');
      const sig = s.sign('header.payload');
      // HMAC-SHA256 produces 32-byte digests.
      expect(sig.length).toBe(32);
      expect(s.verify('header.payload', sig)).toBe(true);
    });

    it('rejects a tampered signature under HS256', () => {
      const s = getActiveSigner();
      if (s === null) throw new Error('expected signer');
      const sig = s.sign('header.payload');
      const tampered = Buffer.concat([sig.subarray(0, sig.length - 1), Buffer.from([0])]);
      // Almost always different from the real last byte; if by chance
      // the original last byte was already 0x00, flip it.
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
      const native = createHmac('sha256', 's'.repeat(32)).update('foo.bar').digest();
      expect(Buffer.compare(ours, native)).toBe(0);
    });
  });

  describe('getVerifiersForAlg', () => {
    it('returns the current HS256 key as a verifier when LOOP_JWT_SIGNING_KEY is set', () => {
      const verifiers = getVerifiersForAlg('HS256');
      expect(verifiers.length).toBeGreaterThanOrEqual(1);
      expect(verifiers[0]?.alg).toBe('HS256');
    });

    it('returns BOTH current and previous keys during a rotation window', () => {
      // Mutate process.env directly — the env module re-reads on each
      // call, but signer.ts also re-reads via the env import. Match
      // the existing test pattern in tokens.test.ts: override at the
      // env mock level via vi.doMock.
      vi.resetModules();
      process.env['LOOP_JWT_SIGNING_KEY'] = 'a'.repeat(32);
      process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'] = 'b'.repeat(32);
      // Re-import after env mutation — picks up both keys.
      return import('../signer.js').then(({ getVerifiersForAlg: re }) => {
        const verifiers = re('HS256');
        expect(verifiers.length).toBe(2);
        expect(verifiers.every((v) => v.alg === 'HS256')).toBe(true);
        delete process.env['LOOP_JWT_SIGNING_KEY_PREVIOUS'];
      });
    });

    it('returns an empty array for RS256 — Track A.2 reserved', () => {
      // Track A.1 only ships HS256. RS256 verifiers are wired in A.2
      // when the JWKS publish + LOOP_JWT_PRIVATE_KEY family lands.
      const verifiers = getVerifiersForAlg('RS256');
      expect(verifiers).toEqual([]);
    });
  });

  describe('isAnySignerConfigured', () => {
    it('returns true when the signing key is present', () => {
      expect(isAnySignerConfigured()).toBe(true);
    });
  });
});
