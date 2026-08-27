import { describe, it, expect, vi } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

import { getMerchantImageUrl } from '../image';

const MERCHANT = { id: 'm-1', updatedAt: '2026-08-26T10:00:00Z' };

describe('getMerchantImageUrl', () => {
  it('starts with API_BASE/api/image', () => {
    const url = getMerchantImageUrl(MERCHANT, 'logo', 200);
    expect(url.startsWith('http://test-api/api/image?')).toBe(true);
  });

  it('emits merchantId + kind, never a URL', () => {
    const url = new URL(getMerchantImageUrl(MERCHANT, 'card', 640));
    expect(url.searchParams.get('merchantId')).toBe('m-1');
    expect(url.searchParams.get('kind')).toBe('card');
    expect(url.searchParams.has('url')).toBe(false);
  });

  it('includes width only when positive', () => {
    const withWidth = new URL(getMerchantImageUrl(MERCHANT, 'logo', 100));
    expect(withWidth.searchParams.get('width')).toBe('100');
    const noWidth = new URL(getMerchantImageUrl(MERCHANT, 'logo', 0));
    expect(noWidth.searchParams.has('width')).toBe(false);
    const defaulted = new URL(getMerchantImageUrl(MERCHANT, 'logo'));
    expect(defaulted.searchParams.has('width')).toBe(false);
  });

  it('defaults quality to 80 and accepts an override', () => {
    expect(new URL(getMerchantImageUrl(MERCHANT, 'logo', 100)).searchParams.get('quality')).toBe(
      '80',
    );
    expect(
      new URL(getMerchantImageUrl(MERCHANT, 'logo', 100, 50)).searchParams.get('quality'),
    ).toBe('50');
  });

  it('passes updatedAt as the v cache-busting version', () => {
    const url = new URL(getMerchantImageUrl(MERCHANT, 'logo', 100));
    expect(url.searchParams.get('v')).toBe('2026-08-26T10:00:00Z');
  });

  it('omits v when the merchant has no updatedAt', () => {
    const url = new URL(getMerchantImageUrl({ id: 'm-2' }, 'logo', 100));
    expect(url.searchParams.has('v')).toBe(false);
    const empty = new URL(getMerchantImageUrl({ id: 'm-2', updatedAt: '' }, 'logo', 100));
    expect(empty.searchParams.has('v')).toBe(false);
  });

  it('supports the pin kind for map markers', () => {
    const url = new URL(getMerchantImageUrl(MERCHANT, 'pin', 64));
    expect(url.searchParams.get('kind')).toBe('pin');
  });
});
