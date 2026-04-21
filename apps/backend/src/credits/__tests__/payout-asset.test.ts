import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Env mock — tests swap the three LOOP issuer env values by mutating
 * this object before the module under test re-reads `env.*`. We
 * re-import the module inside each `it` so the mock takes effect.
 */
const { envState } = vi.hoisted(() => ({
  envState: {
    LOOP_STELLAR_USDLOOP_ISSUER: undefined as string | undefined,
    LOOP_STELLAR_GBPLOOP_ISSUER: undefined as string | undefined,
    LOOP_STELLAR_EURLOOP_ISSUER: undefined as string | undefined,
  },
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

// The schema module pulls in drizzle + postgres-js at import time;
// mock it down to the pure-JS HomeCurrency export the module uses.
vi.mock('../../db/schema.js', () => ({
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

const USDLOOP_ISSUER = 'GA' + '1'.repeat(55);
const GBPLOOP_ISSUER = 'GB' + '2'.repeat(55);
const EURLOOP_ISSUER = 'GC' + '3'.repeat(55);

beforeEach(() => {
  envState.LOOP_STELLAR_USDLOOP_ISSUER = undefined;
  envState.LOOP_STELLAR_GBPLOOP_ISSUER = undefined;
  envState.LOOP_STELLAR_EURLOOP_ISSUER = undefined;
  vi.resetModules();
});

describe('payoutAssetFor', () => {
  it('maps each home currency to its matching LOOP asset code', async () => {
    const { payoutAssetFor } = await import('../payout-asset.js');
    expect(payoutAssetFor('USD').code).toBe('USDLOOP');
    expect(payoutAssetFor('GBP').code).toBe('GBPLOOP');
    expect(payoutAssetFor('EUR').code).toBe('EURLOOP');
  });

  it('returns null issuer when the matching env var is not set', async () => {
    const { payoutAssetFor } = await import('../payout-asset.js');
    expect(payoutAssetFor('USD').issuer).toBeNull();
    expect(payoutAssetFor('GBP').issuer).toBeNull();
    expect(payoutAssetFor('EUR').issuer).toBeNull();
  });

  it('returns the configured issuer when the matching env var is set', async () => {
    envState.LOOP_STELLAR_USDLOOP_ISSUER = USDLOOP_ISSUER;
    envState.LOOP_STELLAR_GBPLOOP_ISSUER = GBPLOOP_ISSUER;
    envState.LOOP_STELLAR_EURLOOP_ISSUER = EURLOOP_ISSUER;
    const { payoutAssetFor } = await import('../payout-asset.js');
    expect(payoutAssetFor('USD').issuer).toBe(USDLOOP_ISSUER);
    expect(payoutAssetFor('GBP').issuer).toBe(GBPLOOP_ISSUER);
    expect(payoutAssetFor('EUR').issuer).toBe(EURLOOP_ISSUER);
  });

  it('resolves currencies independently — a partially-configured deployment works per-currency', async () => {
    envState.LOOP_STELLAR_GBPLOOP_ISSUER = GBPLOOP_ISSUER;
    const { payoutAssetFor } = await import('../payout-asset.js');
    expect(payoutAssetFor('USD').issuer).toBeNull();
    expect(payoutAssetFor('GBP').issuer).toBe(GBPLOOP_ISSUER);
    expect(payoutAssetFor('EUR').issuer).toBeNull();
  });
});

describe('configuredLoopPayableAssets', () => {
  it('is empty when no issuer is configured', async () => {
    const { configuredLoopPayableAssets } = await import('../payout-asset.js');
    expect(configuredLoopPayableAssets()).toEqual([]);
  });

  it('omits currencies whose issuer is unset — prevents watcher accepting a spoofed LOOP asset', async () => {
    envState.LOOP_STELLAR_USDLOOP_ISSUER = USDLOOP_ISSUER;
    envState.LOOP_STELLAR_EURLOOP_ISSUER = EURLOOP_ISSUER;
    const { configuredLoopPayableAssets } = await import('../payout-asset.js');
    const assets = configuredLoopPayableAssets();
    expect(assets).toHaveLength(2);
    expect(assets).toContainEqual({ code: 'USDLOOP', issuer: USDLOOP_ISSUER });
    expect(assets).toContainEqual({ code: 'EURLOOP', issuer: EURLOOP_ISSUER });
    expect(assets.map((a) => a.code)).not.toContain('GBPLOOP');
  });

  it('returns all three pairs when every issuer is configured', async () => {
    envState.LOOP_STELLAR_USDLOOP_ISSUER = USDLOOP_ISSUER;
    envState.LOOP_STELLAR_GBPLOOP_ISSUER = GBPLOOP_ISSUER;
    envState.LOOP_STELLAR_EURLOOP_ISSUER = EURLOOP_ISSUER;
    const { configuredLoopPayableAssets } = await import('../payout-asset.js');
    expect(configuredLoopPayableAssets()).toEqual([
      { code: 'USDLOOP', issuer: USDLOOP_ISSUER },
      { code: 'GBPLOOP', issuer: GBPLOOP_ISSUER },
      { code: 'EURLOOP', issuer: EURLOOP_ISSUER },
    ]);
  });
});
