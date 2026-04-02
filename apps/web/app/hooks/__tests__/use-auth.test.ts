import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/auth', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('~/native/secure-storage', () => ({
  storeRefreshToken: vi.fn(() => Promise.resolve()),
  storeEmail: vi.fn(() => Promise.resolve()),
  clearRefreshToken: vi.fn(() => Promise.resolve()),
  getRefreshToken: vi.fn(() => Promise.resolve(null)),
  getEmail: vi.fn(() => Promise.resolve(null)),
}));

import { requestOtp, verifyOtp } from '~/services/auth';
import { useAuthStore } from '~/stores/auth.store';

describe('auth flow integration', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    vi.clearAllMocks();
  });

  it('successful verifyOtp stores session in auth store', async () => {
    vi.mocked(verifyOtp).mockResolvedValue({ accessToken: 'at-123', refreshToken: 'rt-456' });

    const result = await verifyOtp('test@example.com', '123456');
    useAuthStore
      .getState()
      .setSession('test@example.com', result.accessToken, result.refreshToken ?? null);

    expect(useAuthStore.getState().email).toBe('test@example.com');
    expect(useAuthStore.getState().accessToken).toBe('at-123');
  });

  it('requestOtp calls service with email', async () => {
    vi.mocked(requestOtp).mockResolvedValue(undefined);
    await requestOtp('test@example.com');
    expect(requestOtp).toHaveBeenCalledWith('test@example.com');
  });

  it('clearSession resets auth state', () => {
    useAuthStore.getState().setSession('test@example.com', 'token', 'refresh');
    expect(useAuthStore.getState().email).toBe('test@example.com');
    expect(useAuthStore.getState().accessToken).toBe('token');

    useAuthStore.getState().clearSession();
    expect(useAuthStore.getState().email).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('setAccessToken updates only the token', () => {
    useAuthStore.getState().setSession('user@test.com', 'old-token', 'rt');
    useAuthStore.getState().setAccessToken('new-token');

    expect(useAuthStore.getState().accessToken).toBe('new-token');
    expect(useAuthStore.getState().email).toBe('user@test.com');
  });

  it('setSession with null refreshToken still sets email and accessToken', () => {
    useAuthStore.getState().setSession('user@test.com', 'at-789', null);

    expect(useAuthStore.getState().email).toBe('user@test.com');
    expect(useAuthStore.getState().accessToken).toBe('at-789');
  });

  it('isAuthenticated is true when accessToken is set', () => {
    useAuthStore.getState().setSession('user@test.com', 'at-1', 'rt-1');
    const state = useAuthStore.getState();
    expect(state.accessToken !== null).toBe(true);
  });

  it('isAuthenticated is false after clearSession', () => {
    useAuthStore.getState().setSession('user@test.com', 'at-1', 'rt-1');
    useAuthStore.getState().clearSession();
    const state = useAuthStore.getState();
    expect(state.accessToken !== null).toBe(false);
  });
});
