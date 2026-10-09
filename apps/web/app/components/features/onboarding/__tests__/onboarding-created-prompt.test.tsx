// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAuthStore } from '~/stores/auth.store';

const verifyOtpMock = vi.fn();
vi.mock('~/services/auth', () => ({
  requestOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: (...args: unknown[]) => verifyOtpMock(...args),
}));
vi.mock('~/native/secure-storage', () => ({
  storeRefreshToken: vi.fn().mockResolvedValue(undefined),
  storeAccessToken: vi.fn().mockResolvedValue(undefined),
  storeEmail: vi.fn().mockResolvedValue(undefined),
  clearRefreshToken: vi.fn().mockResolvedValue(undefined),
}));

import { useOnboardingAuth } from '../signup-tail';

beforeEach(() => {
  verifyOtpMock.mockReset();
  useAuthStore.getState().clearSession();
});
afterEach(cleanup);

describe('useOnboardingAuth().verify — stable-currency prompt', () => {
  it('arms the prompt when the sign-in created the account', async () => {
    verifyOtpMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', created: true });
    const { result } = renderHook(() => useOnboardingAuth());
    await act(async () => {
      await result.current.verify('new@example.com', '123456');
    });
    expect(useAuthStore.getState().stableCurrencyPromptPending).toBe(true);
  });

  it('leaves the prompt alone for an existing account', async () => {
    verifyOtpMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', created: false });
    const { result } = renderHook(() => useOnboardingAuth());
    await act(async () => {
      await result.current.verify('old@example.com', '123456');
    });
    expect(useAuthStore.getState().stableCurrencyPromptPending).toBe(false);
  });
});
