// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { CashbackHistoryEntry, UserMeView } from '~/services/user';

/**
 * P2-DATE-SWEEP2: the Account-screen cashback-history row date used to format
 * with the HOST default locale (`toLocaleDateString(undefined, …)`), so a
 * `/de/en` reader saw the CI box / `navigator.language` order instead of their
 * chosen market (ADR 034). The fix reads the active route locale
 * (`useLocaleTag()`, hoisted above the `isError` early return per Rules of
 * Hooks) and routes the date through the shared `i18n/format#formatDateTime`.
 *
 * The `{ month, day, year }` shape has no time, so the distinguishing axis is
 * date ORDER: en-CA is month-first ("Apr 20, 2026") while the en-GB / en-IN
 * host default is day-first ("20 Apr 2026"). Rendered under a fixed `en-CA`
 * route, a month-first match proves the *route* locale drove the format, not
 * the host default. Anchored day (`\d{1,2}`) keeps it timezone-robust around
 * the noon-UTC instant.
 *
 * Mock surface mirrors auth.account-balance.test.tsx.
 */

const { userMock, authMock } = vi.hoisted(() => ({
  userMock: {
    getMe: vi.fn(),
    getCashbackHistory: vi.fn(),
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
    wallet: undefined,
    isActivated: false,
    balanceFor: () => '0',
    isLoading: false,
    isError: false,
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
vi.mock('~/components/features/cashback/PendingCashbackChip', () => ({
  PendingCashbackChip: () => null,
}));

import AuthRoute from '../auth';

afterEach(cleanup);

beforeEach(() => {
  userMock.getMe.mockReset();
  userMock.getCashbackHistory.mockReset();
  userMock.getMe.mockResolvedValue(mkMe());
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

function mkEntry(overrides: Partial<CashbackHistoryEntry> = {}): CashbackHistoryEntry {
  return {
    id: 'tx-1',
    type: 'cashback',
    amountMinor: '250',
    currency: 'GBP',
    referenceType: null,
    referenceId: null,
    createdAt: '2026-04-20T12:00:00.000Z',
    ...overrides,
  };
}

function renderAuthAt(country: string, lang: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/${country}/${lang}/account`]}>
        <Routes>
          <Route path="/:country/:lang/account" element={<AuthRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Account cashback-history row date (P2-DATE-SWEEP2)', () => {
  it('formats the ledger-row date in the active route locale (en-CA month-first)', async () => {
    userMock.getCashbackHistory.mockResolvedValue({ entries: [mkEntry()] });
    renderAuthAt('ca', 'en');
    // en-CA is month-first ("Apr 20, 2026"); the en-GB host default is
    // day-first ("20 Apr 2026"), which would NOT match /^Apr …/ — so this is
    // red unless the route locale is threaded into the history-row date.
    expect(await screen.findByText(/^Apr \d{1,2}, 2026$/)).toBeTruthy();
    // And the day-first host-default order must be absent.
    expect(screen.queryByText(/^\d{1,2} Apr 2026$/)).toBeNull();
  });
});
