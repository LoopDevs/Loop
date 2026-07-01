// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserWalletResponse } from '~/services/wallet';

const { walletMock, authMock } = vi.hoisted(() => ({
  walletMock: { getMyWallet: vi.fn() },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/wallet', () => ({
  getMyWallet: () => walletMock.getMyWallet(),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useWallet, WALLET_QUERY_KEY } from '../use-wallet';

afterEach(cleanup);

beforeEach(() => {
  walletMock.getMyWallet.mockReset();
  authMock.isAuthenticated = true;
});

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function activatedWallet(): UserWalletResponse {
  return {
    address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
    provisioning: 'activated',
    balances: [
      { assetCode: 'GBPLOOP', balance: '42.5000000' },
      { assetCode: 'EURLOOP', balance: '0.0000000' },
    ],
    interestApyBps: 300,
    stale: false,
  };
}

describe('useWallet', () => {
  it('does not fire the request when unauthenticated', () => {
    authMock.isAuthenticated = false;
    const { result } = renderHook(() => useWallet(), { wrapper: makeWrapper() });
    expect(walletMock.getMyWallet).not.toHaveBeenCalled();
    expect(result.current.wallet).toBeUndefined();
    expect(result.current.isActivated).toBe(false);
    expect(result.current.balanceFor('GBPLOOP')).toBe('0');
  });

  it('fetches and exposes the wallet when authenticated', async () => {
    walletMock.getMyWallet.mockResolvedValue(activatedWallet());
    const { result } = renderHook(() => useWallet(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.wallet).toBeDefined();
    });
    expect(walletMock.getMyWallet).toHaveBeenCalledTimes(1);
    expect(result.current.isActivated).toBe(true);
    expect(result.current.balanceFor('GBPLOOP')).toBe('42.5000000');
    // No row for that code → '0', not undefined.
    expect(result.current.balanceFor('USDLOOP')).toBe('0');
  });

  it('isActivated stays false for provisioning states', async () => {
    walletMock.getMyWallet.mockResolvedValue({
      ...activatedWallet(),
      provisioning: 'wallet_created',
      balances: [],
    });
    const { result } = renderHook(() => useWallet(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.wallet).toBeDefined();
    });
    expect(result.current.isActivated).toBe(false);
  });

  it('surfaces isError on fetch failure', async () => {
    walletMock.getMyWallet.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useWallet(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.wallet).toBeUndefined();
  });

  it('exposes the me-surface query key for invalidation', () => {
    expect(WALLET_QUERY_KEY).toEqual(['me', 'wallet']);
  });
});
