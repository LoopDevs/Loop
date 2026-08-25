import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
const mockTryRefresh = vi.fn<() => Promise<string | null>>();
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  tryRefresh: () => mockTryRefresh(),
}));
vi.mock('~/native/platform', () => ({
  getPlatform: vi.fn(() => 'web'),
}));
const mockGetRefreshToken = vi.fn<() => Promise<string | null>>();
vi.mock('~/native/secure-storage', () => ({
  getRefreshToken: () => mockGetRefreshToken(),
  storeRefreshToken: vi.fn(() => Promise.resolve()),
  storeAccessToken: vi.fn(() => Promise.resolve()),
  storeEmail: vi.fn(() => Promise.resolve()),
  clearRefreshToken: vi.fn(() => Promise.resolve()),
}));

import { requestOtp, verifyOtp, logout } from '../auth';
import { apiRequest } from '../api-client';
import { getPlatform } from '~/native/platform';
import { useAuthStore } from '~/stores/auth.store';

const mockApiRequest = vi.mocked(apiRequest);
const mockGetPlatform = vi.mocked(getPlatform);

/** Unsigned JWT expiring `expSecondsFromNow` from now — decode-only. */
const fakeJwt = (expSecondsFromNow: number): string => {
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
};

describe('auth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlatform.mockReturnValue('web');
    mockGetRefreshToken.mockResolvedValue(null);
    mockTryRefresh.mockResolvedValue(null);
    useAuthStore.setState({ email: null, accessToken: null });
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
    it('sends DELETE bearer-less with platform only when no tokens exist', async () => {
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      mockGetRefreshToken.mockResolvedValue(null);
      await logout();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web' },
        headers: {},
      });
    });

    it('stamps Authorization + X-Client-Id from a live access token', async () => {
      const fresh = fakeJwt(3600);
      useAuthStore.setState({ accessToken: fresh });
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      mockGetRefreshToken.mockResolvedValue('rt-abc');
      await logout();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web', refreshToken: 'rt-abc' },
        headers: { Authorization: `Bearer ${fresh}`, 'X-Client-Id': 'loopweb' },
      });
      expect(mockTryRefresh).not.toHaveBeenCalled();
    });

    it('rolls an expired access token before the request, and reads the refresh token after the roll', async () => {
      useAuthStore.setState({ accessToken: fakeJwt(-60) });
      mockTryRefresh.mockResolvedValue('at-rolled');
      // The roll rotates the stored refresh token; logout must send the
      // post-roll row, which this mock's return value stands in for.
      mockGetRefreshToken.mockResolvedValue('rt-post-roll');
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      await logout();
      expect(mockTryRefresh).toHaveBeenCalledTimes(1);
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web', refreshToken: 'rt-post-roll' },
        headers: { Authorization: 'Bearer at-rolled', 'X-Client-Id': 'loopweb' },
      });
    });

    it('goes bearer-less when the roll fails (backend skips upstream revoke)', async () => {
      useAuthStore.setState({ accessToken: fakeJwt(-60) });
      mockTryRefresh.mockResolvedValue(null);
      mockGetRefreshToken.mockResolvedValue('rt-abc');
      mockApiRequest.mockResolvedValue({ message: 'ok' });
      await logout();
      expect(mockApiRequest).toHaveBeenCalledWith('/api/auth/session', {
        method: 'DELETE',
        body: { platform: 'web', refreshToken: 'rt-abc' },
        headers: {},
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
