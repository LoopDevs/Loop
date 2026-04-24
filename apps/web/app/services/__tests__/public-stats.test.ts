import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api-client', () => ({
  apiRequest: vi.fn(),
}));

import {
  getPublicCashbackStats,
  getPublicTopCashbackMerchants,
  getPublicMerchant,
  getPublicCashbackPreview,
  getPublicLoopAssets,
  getPublicFlywheelStats,
} from '../public-stats';
import { apiRequest } from '../api-client';

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

/**
 * A2-1702 — every public-stats fetcher is a thin `apiRequest` wrapper.
 * Tests confirm path + query-string shape since a regression here
 * would silently hit the wrong backend route or pass the wrong
 * parameter name. The backend side is tested separately (ADR 020
 * `never-500` behaviour). All these endpoints live under `/api/public/*`.
 */

describe('getPublicCashbackStats', () => {
  it('GETs /api/public/cashback-stats with no params', async () => {
    mockApiRequest.mockResolvedValue({
      orderCount: 0,
      totalCashbackMinor: '0',
      perCurrency: [],
    });
    await getPublicCashbackStats();
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/cashback-stats');
  });
});

describe('getPublicTopCashbackMerchants', () => {
  it('omits ?limit= when no limit provided', async () => {
    mockApiRequest.mockResolvedValue({ merchants: [] });
    await getPublicTopCashbackMerchants();
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/top-cashback-merchants');
  });

  it('appends ?limit= when provided', async () => {
    mockApiRequest.mockResolvedValue({ merchants: [] });
    await getPublicTopCashbackMerchants({ limit: 25 });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/top-cashback-merchants?limit=25');
  });

  it('sends a limit of 1 (backend clamps to 1..50)', async () => {
    mockApiRequest.mockResolvedValue({ merchants: [] });
    await getPublicTopCashbackMerchants({ limit: 1 });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/top-cashback-merchants?limit=1');
  });
});

describe('getPublicMerchant', () => {
  it('encodes the id / slug path segment', async () => {
    mockApiRequest.mockResolvedValue({
      id: 'm1',
      slug: 'acme',
      name: 'Acme',
      imageUrl: null,
      cashbackRate: null,
      currencies: [],
    });
    await getPublicMerchant('slug with spaces');
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/merchants/slug%20with%20spaces');
  });

  it('forwards a plain id untouched when no encoding is needed', async () => {
    mockApiRequest.mockResolvedValue({
      id: 'abc123',
      slug: 'abc123',
      name: 'Abc',
      imageUrl: null,
      cashbackRate: null,
      currencies: [],
    });
    await getPublicMerchant('abc123');
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/merchants/abc123');
  });
});

describe('getPublicCashbackPreview', () => {
  it('serialises merchantId + amountMinor as URLSearchParams', async () => {
    mockApiRequest.mockResolvedValue({
      merchantId: 'm1',
      amountMinor: '500',
      cashbackMinor: '50',
      cashbackRate: 10,
      currency: 'GBP',
    });
    await getPublicCashbackPreview({ merchantId: 'm1', amountMinor: 500 });
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/api/public/cashback-preview?merchantId=m1&amountMinor=500',
    );
  });

  it('url-encodes merchantIds that contain special characters', async () => {
    mockApiRequest.mockResolvedValue({
      merchantId: 'a/b&c',
      amountMinor: '100',
      cashbackMinor: '10',
      cashbackRate: 10,
      currency: 'USD',
    });
    await getPublicCashbackPreview({ merchantId: 'a/b&c', amountMinor: 100 });
    const [[path]] = mockApiRequest.mock.calls as [[string]];
    expect(path).toBe('/api/public/cashback-preview?merchantId=a%2Fb%26c&amountMinor=100');
  });
});

describe('getPublicLoopAssets', () => {
  it('GETs /api/public/loop-assets', async () => {
    mockApiRequest.mockResolvedValue({ assets: [] });
    await getPublicLoopAssets();
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/loop-assets');
  });
});

describe('getPublicFlywheelStats', () => {
  it('GETs /api/public/flywheel-stats', async () => {
    mockApiRequest.mockResolvedValue({
      windowDays: 30,
      fulfilledOrders: 0,
      recycledOrders: 0,
      pctRecycled: '0.0',
    });
    await getPublicFlywheelStats();
    expect(mockApiRequest).toHaveBeenCalledWith('/api/public/flywheel-stats');
  });
});
