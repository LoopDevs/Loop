import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { fetchMerchants, fetchMerchant, fetchMerchantBySlug } from '../merchants';
import { apiRequest, authenticatedRequest } from '../api-client';

const mockApiRequest = vi.mocked(apiRequest);
const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

describe('merchants service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchMerchants', () => {
    it('calls with page, limit, and search query', async () => {
      mockApiRequest.mockResolvedValue({ merchants: [], pagination: {} });
      await fetchMerchants({ page: 2, limit: 10, q: 'target' });
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants?page=2&limit=10&q=target');
    });

    it('omits undefined params from query string', async () => {
      mockApiRequest.mockResolvedValue({ merchants: [], pagination: {} });
      await fetchMerchants({});
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants');
    });

    it('omits query string entirely when no params', async () => {
      mockApiRequest.mockResolvedValue({ merchants: [], pagination: {} });
      await fetchMerchants();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants');
    });

    it('includes only page when only page is set', async () => {
      mockApiRequest.mockResolvedValue({ merchants: [], pagination: {} });
      await fetchMerchants({ page: 3 });
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants?page=3');
    });

    it('includes only q when only search query is set', async () => {
      mockApiRequest.mockResolvedValue({ merchants: [], pagination: {} });
      await fetchMerchants({ q: 'starbucks' });
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants?q=starbucks');
    });

    it('returns the API response', async () => {
      const response = { merchants: [{ id: '1', name: 'Test' }], pagination: { total: 1 } };
      mockApiRequest.mockResolvedValue(response);
      const result = await fetchMerchants({ page: 1 });
      expect(result).toEqual(response);
    });
  });

  describe('fetchMerchant', () => {
    // fetchMerchant now hits the authenticated endpoint
    // (`/api/merchants/:id` proxies upstream CTX for long-form content),
    // so it goes through `authenticatedRequest`, not `apiRequest`.
    it('calls correct URL with merchant id', async () => {
      mockAuthenticatedRequest.mockResolvedValue({ merchant: { id: 'abc-123' } });
      await fetchMerchant('abc-123');
      expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/merchants/abc-123');
    });

    it('encodes the merchant id', async () => {
      mockAuthenticatedRequest.mockResolvedValue({ merchant: { id: 'a/b' } });
      await fetchMerchant('a/b');
      expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/merchants/a%2Fb');
    });

    it('returns the API response', async () => {
      const response = { merchant: { id: '1', name: 'Test Merchant' } };
      mockAuthenticatedRequest.mockResolvedValue(response);
      const result = await fetchMerchant('1');
      expect(result).toEqual(response);
    });
  });

  describe('fetchMerchantBySlug', () => {
    it('calls correct URL with slug', async () => {
      mockApiRequest.mockResolvedValue({ merchant: { id: '1', name: 'Test' } });
      await fetchMerchantBySlug('test-merchant');
      expect(mockApiRequest).toHaveBeenCalledWith('/api/merchants/by-slug/test-merchant');
    });

    it('encodes the slug', async () => {
      mockApiRequest.mockResolvedValue({ merchant: { id: '1' } });
      await fetchMerchantBySlug('café & more');
      expect(mockApiRequest).toHaveBeenCalledWith(
        `/api/merchants/by-slug/${encodeURIComponent('café & more')}`,
      );
    });

    it('returns the API response', async () => {
      const response = { merchant: { id: '1', name: 'Slug Merchant' } };
      mockApiRequest.mockResolvedValue(response);
      const result = await fetchMerchantBySlug('slug-merchant');
      expect(result).toEqual(response);
    });
  });
});
