import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { envState } = vi.hoisted(() => ({
  envState: {
    LOOP_INTEREST_POOL_ACCOUNT: undefined as string | undefined,
    LOOP_STELLAR_OPERATOR_SECRET: undefined as string | undefined,
  },
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: vi.fn((secret: string) => {
      if (secret.startsWith('S') && secret.length === 56) {
        return { publicKey: () => `G${'A'.repeat(55)}` };
      }
      throw new Error('invalid secret');
    }),
  },
}));

import { resolveInterestPoolAccount, __resetInterestPoolForTests } from '../interest-pool.js';

beforeEach(() => {
  envState.LOOP_INTEREST_POOL_ACCOUNT = undefined;
  envState.LOOP_STELLAR_OPERATOR_SECRET = undefined;
  __resetInterestPoolForTests();
});

describe('resolveInterestPoolAccount', () => {
  it('returns null when neither pool account nor operator secret is configured', () => {
    expect(resolveInterestPoolAccount()).toBeNull();
  });

  it('prefers the explicit LOOP_INTEREST_POOL_ACCOUNT when set', () => {
    envState.LOOP_INTEREST_POOL_ACCOUNT = 'GEXPLICITPOOL';
    envState.LOOP_STELLAR_OPERATOR_SECRET = `S${'X'.repeat(55)}`;
    expect(resolveInterestPoolAccount()).toBe('GEXPLICITPOOL');
  });

  it('derives from the operator secret when LOOP_INTEREST_POOL_ACCOUNT is unset', () => {
    envState.LOOP_STELLAR_OPERATOR_SECRET = `S${'A'.repeat(55)}`;
    expect(resolveInterestPoolAccount()).toBe(`G${'A'.repeat(55)}`);
  });

  it('returns null when the operator secret is malformed (caught + logged)', () => {
    envState.LOOP_STELLAR_OPERATOR_SECRET = 'not-a-real-secret';
    expect(resolveInterestPoolAccount()).toBeNull();
  });

  it('caches the resolved value across calls within the same process', () => {
    envState.LOOP_INTEREST_POOL_ACCOUNT = 'GFIRST';
    expect(resolveInterestPoolAccount()).toBe('GFIRST');
    // Flip env without resetting cache → still returns the cached value.
    envState.LOOP_INTEREST_POOL_ACCOUNT = 'GSECOND';
    expect(resolveInterestPoolAccount()).toBe('GFIRST');
    // Reset → re-derives from the new env.
    __resetInterestPoolForTests();
    expect(resolveInterestPoolAccount()).toBe('GSECOND');
  });

  it('caches the null result so a fresh-deployment doesn’t re-derive on every read', () => {
    expect(resolveInterestPoolAccount()).toBeNull();
    envState.LOOP_STELLAR_OPERATOR_SECRET = `S${'A'.repeat(55)}`;
    // Without reset, still null.
    expect(resolveInterestPoolAccount()).toBeNull();
  });
});
