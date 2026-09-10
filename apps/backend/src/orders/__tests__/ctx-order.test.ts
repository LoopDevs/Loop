// CTX contract helper tests — ADR 052
import { describe, it, expect } from 'vitest';
import {
  deriveOrderEconomics,
  mapCtxDisplayStatus,
  parseMajorToMinor,
  paymentInstructionsFromCard,
} from '../ctx-order.js';

describe('parseMajorToMinor', () => {
  it('parses whole and fractional major-unit strings to 2-decimal minor', () => {
    expect(parseMajorToMinor('25')).toBe(2500n);
    expect(parseMajorToMinor('12.34')).toBe(1234n);
    expect(parseMajorToMinor('0.05')).toBe(5n);
    expect(parseMajorToMinor('12.3')).toBe(1230n);
  });

  it('returns null (unknown, never zero) for absent or unparseable values', () => {
    expect(parseMajorToMinor(undefined)).toBeNull();
    expect(parseMajorToMinor('')).toBeNull();
    expect(parseMajorToMinor('12.345')).toBeNull();
    expect(parseMajorToMinor('abc')).toBeNull();
  });
});

describe('mapCtxDisplayStatus', () => {
  it('maps the five CTX display statuses through verbatim', () => {
    for (const s of ['unpaid', 'paid', 'fulfilled', 'rejected', 'refunded'] as const) {
      expect(mapCtxDisplayStatus(s)).toBe(s);
    }
  });

  it('returns null for unknown values (schema drift is not acted on)', () => {
    expect(mapCtxDisplayStatus('processing')).toBeNull();
    expect(mapCtxDisplayStatus('')).toBeNull();
  });
});

describe('paymentInstructionsFromCard', () => {
  const fallback = { cryptoCurrency: 'XLM', amountMinor: 2400n, currency: 'USD' };

  it('prefers the card fields and carries the payment expiry', () => {
    const out = paymentInstructionsFromCard(
      {
        id: 'ctx-1',
        paymentId: 'pay-1',
        paymentFiatAmount: '24.50',
        paymentFiatCurrency: 'GBP',
        paymentCryptoAmount: '150.5',
        paymentCryptoCurrency: 'DASH',
        paymentCryptoAddress: 'Xaddr',
        paymentUrls: { DASH: 'dash:?r=https://ctx.test/crypto/i/pay-1' },
      },
      { id: 'pay-1', expires: '2026-08-01T00:10:00.000Z' },
      fallback,
    );
    expect(out).toEqual({
      ctxPaymentId: 'pay-1',
      cryptoCurrency: 'DASH',
      cryptoAmount: '150.5',
      address: 'Xaddr',
      paymentUrls: { DASH: 'dash:?r=https://ctx.test/crypto/i/pay-1' },
      amountMinor: '2450',
      currency: 'GBP',
      expiresAt: '2026-08-01T00:10:00.000Z',
    });
  });

  it('degrades to the fallback amounts and empty urls (fail-soft pay screen)', () => {
    const out = paymentInstructionsFromCard({ id: 'ctx-1' }, null, fallback);
    expect(out).toEqual({
      ctxPaymentId: null,
      cryptoCurrency: 'XLM',
      cryptoAmount: null,
      address: null,
      paymentUrls: {},
      amountMinor: '2400',
      currency: 'USD',
      expiresAt: null,
    });
  });
});

describe('deriveOrderEconomics', () => {
  const card = (over?: Record<string, unknown>): Parameters<typeof deriveOrderEconomics>[0] => ({
    id: 'ctx-1',
    cardFiatAmount: '100.00',
    userDiscount: 250,
    operatorDiscount: 750,
    ...over,
  });

  it('derives cashback + commission (spread × profit share, floored)', () => {
    expect(deriveOrderEconomics(card(), 5000)).toEqual({
      userCashbackMinor: 250n,
      expectedCommissionMinor: 250n,
    });
  });

  it('returns zero commission when the spread or profit share is non-positive', () => {
    expect(deriveOrderEconomics(card({ operatorDiscount: 250 }), 5000)).toEqual({
      userCashbackMinor: 250n,
      expectedCommissionMinor: 0n,
    });
    expect(deriveOrderEconomics(card(), 0)).toEqual({
      userCashbackMinor: 250n,
      expectedCommissionMinor: 0n,
    });
  });

  it('returns nulls (unknown) when inputs are missing — never zeroes', () => {
    expect(deriveOrderEconomics(card({ cardFiatAmount: undefined }), 5000)).toEqual({
      userCashbackMinor: null,
      expectedCommissionMinor: null,
    });
    expect(deriveOrderEconomics(card({ operatorDiscount: undefined }), 5000)).toEqual({
      userCashbackMinor: 250n,
      expectedCommissionMinor: null,
    });
    expect(deriveOrderEconomics(card(), null)).toEqual({
      userCashbackMinor: 250n,
      expectedCommissionMinor: null,
    });
  });
});
