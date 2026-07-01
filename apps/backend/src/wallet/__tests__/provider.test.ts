import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Factory gating tests (ADR 030 Phase B). The mocked env object is
 * mutated per-test — `getWalletProvider()` reads env at call time,
 * so no module re-import dance is needed.
 */
vi.mock('../../env.js', () => ({
  env: {
    LOOP_WALLET_PROVIDER: '',
    PRIVY_APP_ID: undefined,
    PRIVY_APP_SECRET: undefined,
  },
}));

import { env } from '../../env.js';
import { getWalletProvider, WalletProviderError } from '../provider.js';

const mutableEnv = env as unknown as {
  LOOP_WALLET_PROVIDER: '' | 'privy';
  PRIVY_APP_ID: string | undefined;
  PRIVY_APP_SECRET: string | undefined;
};

beforeEach(() => {
  mutableEnv.LOOP_WALLET_PROVIDER = '';
  mutableEnv.PRIVY_APP_ID = undefined;
  mutableEnv.PRIVY_APP_SECRET = undefined;
});

describe('getWalletProvider', () => {
  it('returns null when LOOP_WALLET_PROVIDER is unset (the default)', () => {
    expect(getWalletProvider()).toBeNull();
  });

  it('returns the Privy adapter when LOOP_WALLET_PROVIDER=privy with credentials', () => {
    mutableEnv.LOOP_WALLET_PROVIDER = 'privy';
    mutableEnv.PRIVY_APP_ID = 'app123';
    mutableEnv.PRIVY_APP_SECRET = 'sec456';
    const provider = getWalletProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe('privy');
  });

  it('fails loudly when privy is selected without credentials (env-mock tripwire)', () => {
    // parseEnv blocks this combination at boot in real deployments;
    // the factory throw is the defence-in-depth for test setups that
    // mock env.js inconsistently.
    mutableEnv.LOOP_WALLET_PROVIDER = 'privy';
    expect(() => getWalletProvider()).toThrowError(WalletProviderError);
  });
});
