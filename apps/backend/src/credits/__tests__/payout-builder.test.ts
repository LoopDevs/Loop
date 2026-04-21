import { describe, it, expect, vi } from 'vitest';

// Mock the payout-asset module so tests control the issuer env
// without touching process.env directly.
const { payoutAssetMock } = vi.hoisted(() => ({
  payoutAssetMock: {
    USD: { code: 'USDLOOP' as const, issuer: null as string | null },
    GBP: { code: 'GBPLOOP' as const, issuer: null as string | null },
    EUR: { code: 'EURLOOP' as const, issuer: null as string | null },
  },
}));
vi.mock('../payout-asset.js', () => ({
  payoutAssetFor: (currency: 'USD' | 'GBP' | 'EUR') => payoutAssetMock[currency],
}));

// schema.ts gets pulled in for the HomeCurrency type; the test
// doesn't use anything at runtime so a minimal stub avoids a real
// drizzle import chain.
vi.mock('../../db/schema.js', () => ({}));

import { buildPayoutIntent } from '../payout-builder.js';

const VALID_ADDRESS = 'G' + 'A'.repeat(55);
const USDLOOP_ISSUER = 'G' + 'B'.repeat(55);

describe('buildPayoutIntent', () => {
  beforeEach_resetIssuers();

  it('skips with no_cashback when userCashbackMinor is 0', () => {
    payoutAssetMock.USD.issuer = USDLOOP_ISSUER;
    const d = buildPayoutIntent({
      stellarAddress: VALID_ADDRESS,
      homeCurrency: 'USD',
      userCashbackMinor: 0n,
      memoSeed: 'order-1',
    });
    expect(d).toEqual({ kind: 'skip', reason: 'no_cashback' });
  });

  it('skips with no_cashback when userCashbackMinor is negative (defensive)', () => {
    payoutAssetMock.USD.issuer = USDLOOP_ISSUER;
    const d = buildPayoutIntent({
      stellarAddress: VALID_ADDRESS,
      homeCurrency: 'USD',
      userCashbackMinor: -1n,
      memoSeed: 'order-1',
    });
    expect(d).toEqual({ kind: 'skip', reason: 'no_cashback' });
  });

  it('skips with no_address when the user has no linked wallet', () => {
    payoutAssetMock.GBP.issuer = 'G' + 'C'.repeat(55);
    const d = buildPayoutIntent({
      stellarAddress: null,
      homeCurrency: 'GBP',
      userCashbackMinor: 500n,
      memoSeed: 'order-1',
    });
    expect(d).toEqual({ kind: 'skip', reason: 'no_address' });
  });

  it('skips with no_issuer when the LOOP issuer env var is unset for the currency', () => {
    // USD has no issuer configured in this test; user has everything
    // else in order. The payout worker should record the intent off-
    // chain and let ops backfill once the issuer is live.
    payoutAssetMock.USD.issuer = null;
    const d = buildPayoutIntent({
      stellarAddress: VALID_ADDRESS,
      homeCurrency: 'USD',
      userCashbackMinor: 500n,
      memoSeed: 'order-1',
    });
    expect(d).toEqual({ kind: 'skip', reason: 'no_issuer' });
  });

  it('builds a pay intent at the 1:1 peg (cashback × 100_000 = stroops)', () => {
    payoutAssetMock.GBP.issuer = 'G' + 'C'.repeat(55);
    const d = buildPayoutIntent({
      stellarAddress: VALID_ADDRESS,
      homeCurrency: 'GBP',
      userCashbackMinor: 250n, // £2.50
      memoSeed: 'order-abc',
    });
    expect(d.kind).toBe('pay');
    if (d.kind !== 'pay') throw new Error('unreachable');
    expect(d.intent).toEqual({
      to: VALID_ADDRESS,
      assetCode: 'GBPLOOP',
      assetIssuer: 'G' + 'C'.repeat(55),
      amountStroops: 25_000_000n, // 250 * 100_000
      memoText: 'order-abc',
    });
  });

  it('truncates memo to 28 bytes (Stellar memo_text limit)', () => {
    payoutAssetMock.EUR.issuer = 'G' + 'D'.repeat(55);
    const d = buildPayoutIntent({
      stellarAddress: VALID_ADDRESS,
      homeCurrency: 'EUR',
      userCashbackMinor: 1n,
      memoSeed: 'x'.repeat(40),
    });
    if (d.kind !== 'pay') throw new Error('unreachable');
    expect(d.intent.memoText).toHaveLength(28);
  });

  it('checks skip reasons in a stable order: no_cashback first, then no_address, then no_issuer', () => {
    payoutAssetMock.USD.issuer = null;
    // 0 cashback + no address + no issuer — no_cashback wins so the
    // payout worker drops the row before any address/issuer lookup.
    const d = buildPayoutIntent({
      stellarAddress: null,
      homeCurrency: 'USD',
      userCashbackMinor: 0n,
      memoSeed: 'order-1',
    });
    expect(d).toEqual({ kind: 'skip', reason: 'no_cashback' });
  });
});

function beforeEach_resetIssuers(): void {
  // Called from each describe block so tests get a clean slate. The
  // vi.hoisted()-constructed object persists across files, so tests
  // that mutate it need an explicit reset.
  beforeEach(() => {
    payoutAssetMock.USD.issuer = null;
    payoutAssetMock.GBP.issuer = null;
    payoutAssetMock.EUR.issuer = null;
  });
}

// Import from vitest — declared at the end so the `beforeEach`
// used by the helper above binds correctly.
import { beforeEach } from 'vitest';
