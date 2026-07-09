// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MobileHome } from '../MobileHome';

/**
 * ADR 042 (B-2): runtime DOM a11y smoke test for the home surface. Static
 * jsx-a11y lint (apps/web/app/**\/*.tsx) catches structural mistakes at
 * write time; this catches what only exists in the composed, rendered DOM.
 * See ADR 042 for why both layers exist.
 *
 * Heavy siblings not the subject of this smoke test (WalletCard,
 * FavoritesStrip, RecentlyPurchasedStrip each fire their own queries) are
 * stubbed to null renders — same pattern as auth.account-balance.test.tsx.
 */

expect.extend(toHaveNoViolations);

afterEach(cleanup);

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
  useAuth: () => ({ isAuthenticated: false, email: null }),
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

function renderHome(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MobileHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MobileHome /> a11y', () => {
  it('has no axe violations at WCAG 2.1 A/AA on the signed-out empty-state render', async () => {
    const { container } = renderHome();
    // Let the initial hydration effect + merchant/orders state settle.
    await waitFor(() => {
      expect(container.querySelector('#mobile-home-grid')).not.toBeNull();
    });
    const results = await axe(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results).toHaveNoViolations();
  });
});
