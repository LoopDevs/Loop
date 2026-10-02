// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { UserAccountView, WalletLinkView } from '@loop/shared';
import type { UserMeView } from '~/services/user';

const { userMock, accountState, authMock } = vi.hoisted(() => ({
  userMock: {
    getMe: vi.fn(),
    getCashbackHistory: vi.fn(),
  },
  accountState: {
    account: undefined as UserAccountView | undefined,
    activeLink: null as WalletLinkView | null,
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getMe: () => userMock.getMe(),
    getCashbackHistory: (opts?: { limit?: number }) => userMock.getCashbackHistory(opts),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: authMock.isAuthenticated,
    email: 'a@b.com',
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signInWithGoogle: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('~/hooks/use-account', () => ({
  ACCOUNT_QUERY_KEY: ['me', 'account'],
  useAccount: () => ({
    account: accountState.account,
    activeLink: accountState.activeLink,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({
    config: {
      phase1Only: false,
      social: { googleClientIdWeb: null, googleClientIdIos: null, googleClientIdAndroid: null },
    },
    isLoading: false,
  }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

vi.mock('~/stores/ui.store', () => ({
  useUiStore: () => ({ themePreference: 'system', setThemePreference: vi.fn() }),
}));

vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));

import AuthRoute from '../auth';

afterEach(cleanup);

beforeEach(() => {
  userMock.getMe.mockReset();
  userMock.getCashbackHistory.mockReset();
  userMock.getCashbackHistory.mockResolvedValue({ entries: [] });
  accountState.account = undefined;
  accountState.activeLink = null;
});

function mkMe(overrides: Partial<UserMeView> = {}): UserMeView {
  return {
    id: 'user-1',
    email: 'a@b.com',
    isAdmin: false,
    staffRole: null,
    homeCurrency: 'GBP',
    ...overrides,
  };
}

function mkAccount(wallet: UserAccountView['wallet']): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet,
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
  };
}

function renderAccount(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Account screen cashback card', () => {
  it('shows the held stable for the home currency as fiat', async () => {
    userMock.getMe.mockResolvedValue(mkMe());
    accountState.account = mkAccount([
      { currency: 'XLM.GBPLOOP', amount: '42.5000000' },
      { currency: 'XLM.USDC', amount: '999.9900000' },
    ]);
    renderAccount();
    await waitFor(() => {
      expect(screen.getByText(/£42\.50/)).toBeDefined();
    });
    expect(screen.queryByText(/999\.99/)).toBeNull();
  });

  it('shows zero when the account holds nothing in the home stable', async () => {
    userMock.getMe.mockResolvedValue(mkMe());
    accountState.account = mkAccount([]);
    renderAccount();
    await waitFor(() => {
      expect(screen.getByText(/£0\.00/)).toBeDefined();
    });
  });

  it('nudges to link a wallet only while no wallet is linked', async () => {
    userMock.getMe.mockResolvedValue(mkMe());
    accountState.account = mkAccount([]);
    renderAccount();
    await waitFor(() => {
      expect(screen.getByText(/Link a wallet to receive payouts/)).toBeDefined();
    });
    cleanup();
    accountState.activeLink = {
      id: 'w-1',
      chain: 'XLM',
      address: 'G' + 'A'.repeat(55),
      autoPayout: true,
      status: 'active',
      created: '2026-09-01T00:00:00Z',
      removed: null,
    };
    renderAccount();
    await waitFor(() => {
      expect(screen.getByText(/£0\.00/)).toBeDefined();
    });
    expect(screen.queryByText(/Link a wallet to receive payouts/)).toBeNull();
  });
});
