import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * ADR 044 / S4-1 — channel-account resolution. `parseEnv` boot-fails
 * first in production; this module re-derives as defence-in-depth, so
 * both the happy path and the dedupe tripwire are pinned here against
 * a mutable env mock — same posture as `issuer-signers.test.ts`.
 */

const { envState } = vi.hoisted(() => ({
  envState: { env: {} as Record<string, string | undefined> },
}));
vi.mock('../../env.js', () => ({
  get env() {
    return envState.env;
  },
}));

import { resolvePayoutChannels, __resetPayoutChannelsForTests } from '../channel-accounts.js';

const chan1 = Keypair.random();
const chan2 = Keypair.random();

beforeEach(() => {
  __resetPayoutChannelsForTests();
  envState.env = {};
});

describe('resolvePayoutChannels', () => {
  it('returns an empty array when LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS is unset', () => {
    expect(resolvePayoutChannels()).toEqual([]);
  });

  it('returns an empty array for an empty/whitespace-only string', () => {
    envState.env = { LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: '   ' };
    expect(resolvePayoutChannels()).toEqual([]);
  });

  it('resolves a single channel to its derived account', () => {
    envState.env = { LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: chan1.secret() };
    const channels = resolvePayoutChannels();
    expect(channels).toEqual([{ secret: chan1.secret(), account: chan1.publicKey() }]);
  });

  it('resolves multiple comma-separated channels IN ORDER', () => {
    envState.env = {
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${chan2.secret()}`,
    };
    const channels = resolvePayoutChannels();
    expect(channels).toEqual([
      { secret: chan1.secret(), account: chan1.publicKey() },
      { secret: chan2.secret(), account: chan2.publicKey() },
    ]);
  });

  it('trims whitespace around entries', () => {
    envState.env = {
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `  ${chan1.secret()} , ${chan2.secret()}  `,
    };
    const channels = resolvePayoutChannels();
    expect(channels.map((c) => c.account)).toEqual([chan1.publicKey(), chan2.publicKey()]);
  });

  it('skips empty entries from trailing/doubled commas', () => {
    envState.env = {
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},,${chan2.secret()},`,
    };
    const channels = resolvePayoutChannels();
    expect(channels).toHaveLength(2);
  });

  it('throws (defence-in-depth) on a duplicated channel account', () => {
    envState.env = {
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${chan1.secret()}`,
    };
    expect(() => resolvePayoutChannels()).toThrow(/more than once/);
  });

  it('caches the resolution until the test seam resets it', () => {
    envState.env = { LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: chan1.secret() };
    const first = resolvePayoutChannels();
    envState.env = {};
    expect(resolvePayoutChannels()).toBe(first);
    __resetPayoutChannelsForTests();
    expect(resolvePayoutChannels()).toEqual([]);
  });
});
