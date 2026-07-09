// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MobileHome } from '../MobileHome';

/**
 * UX-09 (docs/ux-pass-2026-07-09.md): the mobile home greeting used to
 * show "Welcome back, there" to anonymous visitors — "Welcome back"
 * implies returning/logged-in status they don't have, and "there" read
 * as a fake identity under scrutiny. Anonymous visitors should get a
 * neutral, non-personalized greeting; a named (authenticated) user
 * should still get "Welcome back, <Name>".
 *
 * Mocking mirrors MobileHome.a11y.test.tsx's established pattern.
 */

afterEach(cleanup);

const { authMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: false, email: null as string | null },
}));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: [], isLoading: false, isError: false }),
  useMerchantSearch: () => ({
    merchants: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useMerchantsCashbackRatesMap: () => ({ lookup: () => null }),
}));

vi.mock('~/hooks/use-orders', () => ({
  useOrders: () => ({ orders: [], isLoading: false, isError: false }),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated, email: authMock.email }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

vi.mock('~/services/user', () => ({
  getCashbackSummary: vi.fn().mockRejectedValue(new Error('not authenticated')),
}));

vi.mock('~/components/features/wallet/WalletCard', () => ({ WalletCard: () => null }));
vi.mock('~/components/features/FavoritesStrip', () => ({ FavoritesStrip: () => null }));
vi.mock('~/components/features/RecentlyPurchasedStrip', () => ({
  RecentlyPurchasedStrip: () => null,
}));

function renderHome(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MobileHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MobileHome /> greeting (UX-09)', () => {
  it('shows a neutral "Welcome" (not "Welcome back, there") for an anonymous visitor', async () => {
    authMock.isAuthenticated = false;
    authMock.email = null;
    renderHome();
    await waitFor(() => {
      expect(document.querySelector('#mobile-home-grid')).not.toBeNull();
    });
    expect(screen.getByText('Welcome')).toBeDefined();
    expect(screen.queryByText('Welcome back')).toBeNull();
    expect(screen.queryByText('there')).toBeNull();
    expect(screen.queryByText(/^t$/i)).toBeNull();
  });

  it('shows "Welcome back" + the derived name for an authenticated user', async () => {
    authMock.isAuthenticated = true;
    authMock.email = 'ash@example.com';
    renderHome();
    await waitFor(() => {
      expect(document.querySelector('#mobile-home-grid')).not.toBeNull();
    });
    expect(screen.getByText('Welcome back')).toBeDefined();
    expect(screen.getByText('Ash')).toBeDefined();
  });
});
