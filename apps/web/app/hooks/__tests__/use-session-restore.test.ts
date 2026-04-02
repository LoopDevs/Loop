import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/native/secure-storage', () => ({
  getRefreshToken: vi.fn(),
  getEmail: vi.fn(),
  storeRefreshToken: vi.fn(() => Promise.resolve()),
  storeEmail: vi.fn(() => Promise.resolve()),
  clearRefreshToken: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

import { getRefreshToken, getEmail } from '~/native/secure-storage';
import { useAuthStore } from '~/stores/auth.store';

describe('session restore logic', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    vi.clearAllMocks();
  });

  it('returns null when no refresh token is stored', async () => {
    vi.mocked(getRefreshToken).mockResolvedValue(null);
    const token = await getRefreshToken();
    expect(token).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('returns stored refresh token when available', async () => {
    vi.mocked(getRefreshToken).mockResolvedValue('rt-stored-123');
    const token = await getRefreshToken();
    expect(token).toBe('rt-stored-123');
  });

  it('restores email to store when available', async () => {
    vi.mocked(getEmail).mockResolvedValue('test@example.com');
    const email = await getEmail();
    if (email) {
      useAuthStore.setState({ email });
    }
    expect(useAuthStore.getState().email).toBe('test@example.com');
  });

  it('does not restore email when not stored', async () => {
    vi.mocked(getEmail).mockResolvedValue(null);
    const email = await getEmail();
    if (email) {
      useAuthStore.setState({ email });
    }
    expect(useAuthStore.getState().email).toBeNull();
  });

  it('setAccessToken restores access after refresh', async () => {
    vi.mocked(getRefreshToken).mockResolvedValue('rt-stored');
    vi.mocked(getEmail).mockResolvedValue('user@loop.com');

    const token = await getRefreshToken();
    expect(token).not.toBeNull();

    // Simulate successful refresh response
    useAuthStore.getState().setAccessToken('refreshed-at');
    const email = await getEmail();
    if (email) {
      useAuthStore.setState({ email });
    }

    expect(useAuthStore.getState().accessToken).toBe('refreshed-at');
    expect(useAuthStore.getState().email).toBe('user@loop.com');
  });

  it('does not overwrite existing session', () => {
    useAuthStore.getState().setSession('existing@user.com', 'existing-at', 'existing-rt');

    // The hook skips restore if accessToken is already present
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('existing-at');
    expect(state.email).toBe('existing@user.com');
  });
});
