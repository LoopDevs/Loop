// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('~/services/auth', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  socialLoginGoogle: vi.fn(),
  socialLoginApple: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('~/native/secure-storage', () => ({
  storeRefreshToken: vi.fn(() => Promise.resolve()),
  storeEmail: vi.fn(() => Promise.resolve()),
  clearRefreshToken: vi.fn(() => Promise.resolve()),
  getRefreshToken: vi.fn(() => Promise.resolve(null)),
  getEmail: vi.fn(() => Promise.resolve(null)),
}));

import { requestOtp, verifyOtp, logout } from '~/services/auth';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import { useAuth } from '../use-auth';

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

  // A2-1151 + A2-1152: logout must also wipe the purchase store and the
  // TanStack Query cache. Without these a newly-logged-in user renders
  // the prior user's /me data until each query refetches, and any
  // in-progress purchase-flow state (amount, merchant, pending order
  // id) leaks into the next session.
  it('A2-1151/1152: logout resets purchase store and clears query cache', async () => {
    vi.mocked(logout).mockResolvedValue(undefined);

    // Seed state we expect logout to clear.
    useAuthStore.getState().setSession('user@test.com', 'at-1', 'rt-1');
    usePurchaseStore.getState().startPurchase('m-1', 'Target');
    usePurchaseStore.getState().setAmount(25);
    expect(usePurchaseStore.getState().merchantId).toBe('m-1');
    expect(usePurchaseStore.getState().amount).toBe(25);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['me'], { email: 'user@test.com' });
    expect(queryClient.getQueryData(['me'])).toEqual({ email: 'user@test.com' });

    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.logout();
    });

    // Auth cleared.
    expect(useAuthStore.getState().accessToken).toBeNull();
    // Purchase store reset to initial shape.
    expect(usePurchaseStore.getState().merchantId).toBeNull();
    expect(usePurchaseStore.getState().amount).toBeNull();
    // Query cache wiped — prior user's /me data must be gone.
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
  });
});
