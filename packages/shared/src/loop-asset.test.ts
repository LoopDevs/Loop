import { describe, expect, it } from 'vitest';

import {
  CURRENCY_TO_ASSET_CODE,
  EXTENDED_ORDER_CURRENCIES,
  HOME_CURRENCIES,
  LOOP_ASSET_CODES,
  ORDERABLE_CURRENCIES,
  currencyForLoopAsset,
  isExtendedOrderCurrency,
  isHomeCurrency,
  isLoopAssetCode,
  loopAssetForCurrency,
} from './loop-asset.js';

describe('home currency ↔ LOOP asset mapping (ADR 015)', () => {
  it('pins the three home currencies and three asset codes', () => {
    expect(HOME_CURRENCIES).toEqual(['USD', 'GBP', 'EUR']);
    expect(LOOP_ASSET_CODES).toEqual(['USDLOOP', 'GBPLOOP', 'EURLOOP']);
  });

  it('loopAssetForCurrency / currencyForLoopAsset are exact inverses (bijection)', () => {
    for (const currency of HOME_CURRENCIES) {
      const asset = loopAssetForCurrency(currency);
      expect(LOOP_ASSET_CODES).toContain(asset);
      expect(currencyForLoopAsset(asset)).toBe(currency);
    }
    for (const asset of LOOP_ASSET_CODES) {
      expect(loopAssetForCurrency(currencyForLoopAsset(asset))).toBe(asset);
    }
  });

  it('the forward map covers every home currency with a distinct asset', () => {
    const assets = Object.values(CURRENCY_TO_ASSET_CODE);
    expect(new Set(assets).size).toBe(HOME_CURRENCIES.length);
  });

  it('asset codes follow the {HOME}LOOP scheme', () => {
    for (const currency of HOME_CURRENCIES) {
      expect(loopAssetForCurrency(currency)).toBe(`${currency}LOOP`);
    }
  });
});

describe('type guards', () => {
  it('isLoopAssetCode', () => {
    for (const a of LOOP_ASSET_CODES) expect(isLoopAssetCode(a)).toBe(true);
    expect(isLoopAssetCode('CADLOOP')).toBe(false);
    expect(isLoopAssetCode('usdloop')).toBe(false);
    expect(isLoopAssetCode('')).toBe(false);
  });

  it('isHomeCurrency', () => {
    for (const c of HOME_CURRENCIES) expect(isHomeCurrency(c)).toBe(true);
    expect(isHomeCurrency('CAD')).toBe(false);
    expect(isHomeCurrency('usd')).toBe(false);
  });

  it('isExtendedOrderCurrency', () => {
    for (const c of EXTENDED_ORDER_CURRENCIES) expect(isExtendedOrderCurrency(c)).toBe(true);
    expect(isExtendedOrderCurrency('USD')).toBe(false);
    expect(isExtendedOrderCurrency('NZD')).toBe(false);
  });
});

describe('orderable currencies (ADR 035)', () => {
  it('is exactly home ∪ extended, in that order', () => {
    expect(ORDERABLE_CURRENCIES).toEqual([...HOME_CURRENCIES, ...EXTENDED_ORDER_CURRENCIES]);
  });

  it('home and extended sets are disjoint', () => {
    // An extended code must never be a ledger/charge currency — the
    // schema CHECKs stay pinned to the home three. Overlap here would
    // let an extended code slip into a HomeCurrency position.
    for (const c of EXTENDED_ORDER_CURRENCIES) {
      expect(isHomeCurrency(c)).toBe(false);
    }
  });
});
