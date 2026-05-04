import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { listRecentlyPurchased } from '../recently-purchased';
import { authenticatedRequest } from '../api-client';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

describe('recently-purchased service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticatedRequest.mockResolvedValue({ merchants: [] });
  });

  it('GETs /api/users/me/recently-purchased with no query when limit omitted', async () => {
    await listRecentlyPurchased();
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/users/me/recently-purchased');
  });

  it('appends ?limit when supplied', async () => {
    await listRecentlyPurchased({ limit: 5 });
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith(
      '/api/users/me/recently-purchased?limit=5',
    );
  });
});
