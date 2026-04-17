import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
}));
vi.mock('~/native/platform', () => ({
  getPlatform: vi.fn(() => 'web'),
}));
const mockGetRefreshToken = vi.fn<() => Promise<string | null>>();
vi.mock('~/native/secure-storage', () => ({
  getRefreshToken: () => mockGetRefreshToken(),
}));

import { requestOtp, verifyOtp, logout } from '../auth';
import { apiRequest } from '../api-client';
import { getPlatform } from '~/native/platform';

const mockApiRequest = vi.mocked(apiRequest);
const mockGetPlatform = vi.mocked(getPlatform);

describe('auth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlatform.mockReturnValue('web');
    mockGetRefreshToken.mockResolvedValue(null);
  });

  describe('requestOtp', () => {
    it('sends email and platform in POST body', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      await requestOtp('test@example.com');
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/request-otp', {
        method: 'POST',
        body: { email: 'test@example.com', platform: 'web' },
      });
    });

    it('uses current platform from getPlatform', async () => {
      mockGetPlatform.mockReturnValue('ios');
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      await requestOtp('user@example.com');
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/request-otp', {
        method: 'POST',
        body: { email: 'user@example.com', platform: 'ios' },
      });
    });

    it('returns void (discards response)', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      const result = await requestOtp('test@example.com');
      expect(result).toBeUndefined();
    });
  });

  describe('verifyOtp', () => {
    it('sends email, otp, and platform in POST body', async () => {
      mockApiRequest.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
      await verifyOtp('test@example.com', '123456');
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/verify-otp', {
        method: 'POST',
        body: { email: 'test@example.com', otp: '123456', platform: 'web' },
      });
    });

    it('returns accessToken and refreshToken', async () => {
      mockApiRequest.mockResolvedValue({ accessToken: 'at-123', refreshToken: 'rt-456' });
      const result = await verifyOtp('test@example.com', '654321');
      expect(result).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456' });
    });

    it('uses current platform from getPlatform', async () => {
      mockGetPlatform.mockReturnValue('android');
      mockApiRequest.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
      await verifyOtp('user@example.com', '999999');
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/verify-otp', {
        method: 'POST',
        body: { email: 'user@example.com', otp: '999999', platform: 'android' },
      });
    });
  });

  describe('logout', () => {
    it('sends DELETE to session endpoint with platform and no refreshToken when absent', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      mockGetRefreshToken.mockResolvedValue(null);
      await logout();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web' },
      });
    });

    it('includes refreshToken in body when available (upstream revoke)', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      mockGetRefreshToken.mockResolvedValue('rt-abc');
      await logout();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web', refreshToken: 'rt-abc' },
      });
    });

    it('swallows errors so local logout always proceeds', async () => {
      mockApiRequest.mockRejectedValue(new Error('network down'));
      await expect(logout()).resolves.toBeUndefined();
    });

    it('returns void (discards response)', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      const result = await logout();
      expect(result).toBeUndefined();
    });
  });
});
