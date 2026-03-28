import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock secure-storage before importing store
vi.mock('~/native/secure-storage', () => ({
  storeRefreshToken: vi.fn(),
  clearRefreshToken: vi.fn(),
  storeEmail: vi.fn(),
}));

import { useAuthStore } from '../auth.store';

describe('auth store', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    vi.clearAllMocks();
  });

  it('initializes with null email and token', () => {
    const state = useAuthStore.getState();
    expect(state.email).toBeNull();
    expect(state.accessToken).toBeNull();
  });

  it('setSession stores email and access token', () => {
    useAuthStore.getState().setSession('test@example.com', 'token-123', 'refresh-456');
    const state = useAuthStore.getState();
    expect(state.email).toBe('test@example.com');
    expect(state.accessToken).toBe('token-123');
  });

  it('setSession calls storeRefreshToken when refresh token provided', async () => {
    const { storeRefreshToken } = await import('~/native/secure-storage');
    useAuthStore.getState().setSession('test@example.com', 'token', 'refresh');
    expect(storeRefreshToken).toHaveBeenCalledWith('refresh');
  });

  it('setSession does not call storeRefreshToken when refresh token is null', async () => {
    const { storeRefreshToken } = await import('~/native/secure-storage');
    vi.mocked(storeRefreshToken).mockClear();
    useAuthStore.getState().setSession('test@example.com', 'token', null);
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });

  it('setSession calls storeEmail', async () => {
    const { storeEmail } = await import('~/native/secure-storage');
    useAuthStore.getState().setSession('test@example.com', 'token', 'refresh');
    expect(storeEmail).toHaveBeenCalledWith('test@example.com');
  });

  it('setAccessToken updates only the access token', () => {
    useAuthStore.getState().setSession('test@example.com', 'old-token', null);
    useAuthStore.getState().setAccessToken('new-token');
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('new-token');
    expect(state.email).toBe('test@example.com');
  });

  it('clearSession resets email and token to null', () => {
    useAuthStore.getState().setSession('test@example.com', 'token', 'refresh');
    useAuthStore.getState().clearSession();
    const state = useAuthStore.getState();
    expect(state.email).toBeNull();
    expect(state.accessToken).toBeNull();
  });

  it('clearSession calls clearRefreshToken', async () => {
    const { clearRefreshToken } = await import('~/native/secure-storage');
    vi.mocked(clearRefreshToken).mockClear();
    useAuthStore.getState().clearSession();
    expect(clearRefreshToken).toHaveBeenCalled();
  });
});
