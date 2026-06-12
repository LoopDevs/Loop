import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * ADR 031 — issuer-signer resolution. parseEnv boot-fails first in
 * production; this module re-derives as defence-in-depth, so both
 * the happy path and the mismatch tripwire are pinned here against
 * a mutable env mock.
 */

const { envState } = vi.hoisted(() => ({
  envState: { env: {} as Record<string, string | undefined> },
}));
vi.mock('../../env.js', () => ({
  get env() {
    return envState.env;
  },
}));

import { resolveIssuerSigners, __resetIssuerSignersForTests } from '../issuer-signers.js';

const gbpKp = Keypair.random();
const eurKp = Keypair.random();

beforeEach(() => {
  __resetIssuerSignersForTests();
  envState.env = {};
});

describe('resolveIssuerSigners', () => {
  it('returns an empty map when no issuer secrets are configured', () => {
    envState.env = { LOOP_STELLAR_GBPLOOP_ISSUER: gbpKp.publicKey() };
    expect(resolveIssuerSigners().size).toBe(0);
  });

  it('maps each configured asset to its derived issuer account', () => {
    envState.env = {
      LOOP_STELLAR_GBPLOOP_ISSUER: gbpKp.publicKey(),
      LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: gbpKp.secret(),
      LOOP_STELLAR_EURLOOP_ISSUER: eurKp.publicKey(),
      LOOP_STELLAR_EURLOOP_ISSUER_SECRET: eurKp.secret(),
    };
    const signers = resolveIssuerSigners();
    expect(signers.size).toBe(2);
    expect(signers.get('GBPLOOP')).toEqual({ secret: gbpKp.secret(), account: gbpKp.publicKey() });
    expect(signers.get('EURLOOP')).toEqual({ secret: eurKp.secret(), account: eurKp.publicKey() });
    expect(signers.get('USDLOOP')).toBeUndefined();
  });

  it('throws on a derived-account mismatch (defence-in-depth behind parseEnv)', () => {
    envState.env = {
      LOOP_STELLAR_GBPLOOP_ISSUER: eurKp.publicKey(), // wrong address
      LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: gbpKp.secret(),
    };
    expect(() => resolveIssuerSigners()).toThrow(/does not match/);
  });

  it('throws on an orphan secret with no issuer address', () => {
    envState.env = { LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: gbpKp.secret() };
    expect(() => resolveIssuerSigners()).toThrow(/LOOP_STELLAR_GBPLOOP_ISSUER/);
  });

  it('caches the resolution until the test seam resets it', () => {
    envState.env = {
      LOOP_STELLAR_GBPLOOP_ISSUER: gbpKp.publicKey(),
      LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: gbpKp.secret(),
    };
    const first = resolveIssuerSigners();
    envState.env = {};
    expect(resolveIssuerSigners()).toBe(first);
    __resetIssuerSignersForTests();
    expect(resolveIssuerSigners().size).toBe(0);
  });
});
