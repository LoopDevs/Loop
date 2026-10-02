import { describe, it, expect } from 'vitest';
import {
  activeWalletLink,
  displayCurrencyCode,
  fiatForHeldStable,
  hasPositiveAccountBalance,
  heldStableForCurrency,
  type WalletLinkView,
} from './users-account.js';

function link(overrides: Partial<WalletLinkView> = {}): WalletLinkView {
  return {
    id: 'w-1',
    chain: 'XLM',
    address: 'G' + 'A'.repeat(55),
    autoPayout: true,
    status: 'active',
    created: '2026-09-01T00:00:00Z',
    removed: null,
    ...overrides,
  };
}

describe('heldStableForCurrency', () => {
  it('maps each home currency to its chain-qualified stable', () => {
    expect(heldStableForCurrency('GBP')).toBe('XLM.GBPLOOP');
    expect(heldStableForCurrency('USD')).toBe('XLM.USDC');
    expect(heldStableForCurrency('EUR')).toBe('XLM.EURC');
  });

  it('inverts through fiatForHeldStable and rejects unknown codes', () => {
    expect(fiatForHeldStable('XLM.GBPLOOP')).toBe('GBP');
    expect(fiatForHeldStable('XLM.USDC')).toBe('USD');
    expect(fiatForHeldStable('XLM')).toBeNull();
  });
});

describe('displayCurrencyCode', () => {
  it('strips the chain prefix and leaves bare codes alone', () => {
    expect(displayCurrencyCode('XLM.GBPLOOP')).toBe('GBPLOOP');
    expect(displayCurrencyCode('GBP')).toBe('GBP');
  });
});

describe('activeWalletLink', () => {
  it('returns the active link for the chain', () => {
    const active = link({ id: 'w-2' });
    expect(activeWalletLink([link({ status: 'removed' }), active])).toBe(active);
  });

  it('returns null when every link is removed or on another chain', () => {
    expect(activeWalletLink([link({ status: 'removed' })])).toBeNull();
    expect(activeWalletLink([])).toBeNull();
  });
});

describe('hasPositiveAccountBalance', () => {
  it('is true only when some balance parses above zero', () => {
    expect(hasPositiveAccountBalance([{ currency: 'XLM.USDC', amount: '0.0000001' }])).toBe(true);
    expect(hasPositiveAccountBalance([{ currency: 'XLM.USDC', amount: '0' }])).toBe(false);
    expect(hasPositiveAccountBalance([{ currency: 'XLM.USDC', amount: 'nope' }])).toBe(false);
    expect(hasPositiveAccountBalance([])).toBe(false);
  });
});
