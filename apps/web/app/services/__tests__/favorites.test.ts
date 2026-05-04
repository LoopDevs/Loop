import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { addFavorite, listFavorites, removeFavorite } from '../favorites';
import { authenticatedRequest } from '../api-client';

const mockAuthenticatedRequest = vi.mocked(authenticatedRequest);

describe('favorites service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listFavorites GETs /api/users/me/favorites', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ favorites: [], total: 0 });
    await listFavorites();
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/users/me/favorites');
  });

  it('addFavorite POSTs the merchantId in the body', async () => {
    mockAuthenticatedRequest.mockResolvedValue({
      merchantId: 'amazon',
      createdAt: '2026-05-04T12:00:00.000Z',
      added: true,
    });
    await addFavorite('amazon');
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/users/me/favorites', {
      method: 'POST',
      body: { merchantId: 'amazon' },
    });
  });

  it('removeFavorite DELETEs with the merchantId in the path', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ merchantId: 'amazon', removed: true });
    await removeFavorite('amazon');
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/users/me/favorites/amazon', {
      method: 'DELETE',
    });
  });

  it('removeFavorite percent-encodes special characters in the path', async () => {
    mockAuthenticatedRequest.mockResolvedValue({ merchantId: 'a/b', removed: true });
    await removeFavorite('a/b');
    expect(mockAuthenticatedRequest).toHaveBeenCalledWith('/api/users/me/favorites/a%2Fb', {
      method: 'DELETE',
    });
  });
});
