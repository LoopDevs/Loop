// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { UserMeView } from '~/services/user';

/**
 * Account-screen "Your cashback" card — ADR 036 display sourcing:
 * balance = tokens once activated; mirror is reconciliation-only.
 * Pre-activation the card renders `me.homeCurrencyBalanceMinor` (the
 * off-chain mirror); once the embedded wallet is `activated` it
 * renders the on-chain LOOP balance for the user's home currency.
 */

const { userMock, walletState, authMock } = vi.hoisted(() => ({
  userMock: {
    getMe: vi.fn(),
    getCashbackHistory: vi.fn(),
  },
  walletState: {
    wallet: undefined as
      | {
          address: string | null;
          provisioning: string;
          balances: Array<{ assetCode: string; balance: string }>;
          interestApyBps: number;
          stale: boolean;
        }
      | undefined,
    isActivated: false,
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

vi.mock('~/hooks/use-wallet', () => ({
  WALLET_QUERY_KEY: ['me', 'wallet'],
  useWallet: () => ({
    wallet: walletState.wallet,
    isActivated: walletState.isActivated,
    balanceFor: (code: string) =>
      walletState.wallet?.balances.find((b) => b.assetCode === code)?.balance ?? '0',
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

// Phase-2 config so the account card exercises the live balance copy.
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

// jsdom has no matchMedia; the theme store resolves it at module init.
vi.mock('~/stores/ui.store', () => ({
  useUiStore: () => ({ themePreference: 'system', setThemePreference: vi.fn() }),
}));

// Heavy siblings of the card under test — not the subject here.
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/cashback/PendingCashbackChip', () => ({
  PendingCashbackChip: () => null,
}));

import AuthRoute from '../auth';

afterEach(cleanup);

beforeEach(() => {
  userMock.getMe.mockReset();
  userMock.getCashbackHistory.mockReset();
  userMock.getCashbackHistory.mockResolvedValue({ entries: [] });
  walletState.wallet = undefined;
  walletState.isActivated = false;
});

function mkMe(overrides: Partial<UserMeView> = {}): UserMeView {
  return {
    id: 'user-1',
    email: 'a@b.com',
    isAdmin: false,
    staffRole: null,
    homeCurrency: 'GBP',
    stellarAddress: null,
    homeCurrencyBalanceMinor: '12345',
    ...overrides,
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

describe('Account screen cashback card — ADR 036 balance sourcing', () => {
  it('pre-activation: renders the off-chain mirror (homeCurrencyBalanceMinor)', async () => {
    userMock.getMe.mockResolvedValue(mkMe());
    renderAccount();
    await waitFor(() => {
      expect(screen.getByText(/123\.45/)).toBeDefined();
    });
  });

  it('activated: renders the on-chain home-currency LOOP balance instead of the mirror', async () => {
    userMock.getMe.mockResolvedValue(mkMe({ homeCurrencyBalanceMinor: '99999' }));
    walletState.isActivated = true;
    walletState.wallet = {
      address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
      provisioning: 'activated',
      balances: [{ assetCode: 'GBPLOOP', balance: '42.5000000' }],
      interestApyBps: 0,
      stale: false,
    };
    renderAccount();
    // Both the WalletCard headline and the cashback card now show the
    // token balance — the point: one number, sourced from the tokens.
    await waitFor(() => {
      expect(screen.getAllByText(/42\.50/).length).toBeGreaterThanOrEqual(1);
    });
    // The mirror's £999.99 must not appear anywhere.
    expect(screen.queryByText(/999\.99/)).toBeNull();
  });
});
