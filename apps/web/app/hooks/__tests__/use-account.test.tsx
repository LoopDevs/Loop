// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserAccountView } from '@loop/shared';

const { userMock, authMock } = vi.hoisted(() => ({
  userMock: { getMyAccount: vi.fn() },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/user', () => ({
  getMyAccount: () => userMock.getMyAccount(),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useAccount, ACCOUNT_QUERY_KEY } from '../use-account';

afterEach(cleanup);

beforeEach(() => {
  userMock.getMyAccount.mockReset();
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

function account(overrides: Partial<UserAccountView> = {}): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [{ currency: 'XLM.GBPLOOP', amount: '0.4000000' }],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [
      {
        id: 'w-old',
        chain: 'XLM',
        address: 'G' + 'B'.repeat(55),
        autoPayout: true,
        status: 'removed',
        created: '2026-09-01T00:00:00Z',
        removed: '2026-09-02T00:00:00Z',
      },
      {
        id: 'w-1',
        chain: 'XLM',
        address: 'G' + 'A'.repeat(55),
        autoPayout: true,
        status: 'active',
        created: '2026-09-02T00:00:00Z',
        removed: null,
      },
    ],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

describe('useAccount', () => {
  it('uses the shared account query key', () => {
    expect(ACCOUNT_QUERY_KEY).toEqual(['me', 'account']);
  });

  it('exposes the account and resolves the active XLM link', async () => {
    userMock.getMyAccount.mockResolvedValue(account());
    const { result } = renderHook(() => useAccount(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.account).toBeDefined());
    expect(result.current.activeLink?.id).toBe('w-1');
  });

  it('resolves a null active link when every link is removed', async () => {
    userMock.getMyAccount.mockResolvedValue(
      account({ linkedWallets: [account().linkedWallets[0]!] }),
    );
    const { result } = renderHook(() => useAccount(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.account).toBeDefined());
    expect(result.current.activeLink).toBeNull();
  });

  it('does not fetch while signed out', async () => {
    authMock.isAuthenticated = false;
    const { result } = renderHook(() => useAccount(), { wrapper: makeWrapper() });
    await new Promise((r) => setTimeout(r, 10));
    expect(userMock.getMyAccount).not.toHaveBeenCalled();
    expect(result.current.account).toBeUndefined();
    expect(result.current.activeLink).toBeNull();
  });

  it('surfaces the load error', async () => {
    userMock.getMyAccount.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAccount(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('boom');
  });
});
