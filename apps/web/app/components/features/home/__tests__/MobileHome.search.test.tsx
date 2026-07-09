// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Merchant } from '@loop/shared';
import { MobileHome } from '../MobileHome';

/**
 * S4-7 §3 tail (go-live-plan §P3): MobileHome's search input now calls
 * `GET /api/merchants/search` (via `useMerchantSearch`) instead of
 * client-filtering the full catalog fetched by `useAllMerchants`. Browse
 * mode (no query) is unaffected and still reads from `useAllMerchants` —
 * this file only exercises the search branch. Mocking mirrors
 * MobileHome.a11y.test.tsx's established pattern.
 */

afterEach(cleanup);

const CATALOG: Merchant[] = [
  { id: 'browse-1', name: 'Browse Only', enabled: true, savingsPercentage: 2 },
];

const searchMockState = {
  forceLoading: false,
  forceError: false,
  lastArgs: null as [string, { country?: string; limit?: number; enabled?: boolean }] | null,
};

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: CATALOG, isLoading: false, isError: false }),
  useMerchantSearch: (
    query: string,
    options: { country?: string; limit?: number; enabled?: boolean } = {},
  ) => {
    searchMockState.lastArgs = [query, options];
    if (options.enabled === false) {
      return { merchants: [], isLoading: false, isFetching: false, isError: false, error: null };
    }
    if (searchMockState.forceLoading) {
      return { merchants: [], isLoading: true, isFetching: true, isError: false, error: null };
    }
    if (searchMockState.forceError) {
      return {
        merchants: [],
        isLoading: false,
        isFetching: false,
        isError: true,
        error: new Error('network'),
      };
    }
    const q = query.trim().toLowerCase();
    const merchants: Merchant[] = q.includes('amaz')
      ? [{ id: 'srv-amazon', name: 'Amazon', enabled: true, savingsPercentage: 3 }]
      : [];
    return { merchants, isLoading: false, isFetching: false, isError: false, error: null };
  },
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

describe('<MobileHome /> search', () => {
  afterEach(() => {
    searchMockState.forceLoading = false;
    searchMockState.forceError = false;
    searchMockState.lastArgs = null;
  });

  it('shows the browse grid (from the full catalog) before any query is typed', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    expect(screen.getByText('Browse')).toBeDefined();
  });

  it('calls useMerchantSearch with the debounced query and renders server results', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    const input = screen.getByPlaceholderText('Search 500+ brands');
    fireEvent.change(input, { target: { value: 'amaz' } });
    await waitFor(() => expect(screen.getByText('Amazon')).toBeDefined());
    expect(screen.getByText('Results')).toBeDefined();
    // Browse-only merchant (not server-matched) no longer renders once
    // search mode takes over the grid.
    expect(screen.queryByText('Browse Only')).toBeNull();
  });

  it('shows the "no results" empty state for a query the server matches nothing', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    const input = screen.getByPlaceholderText('Search 500+ brands');
    fireEvent.change(input, { target: { value: 'zzzznope' } });
    await waitFor(() => expect(screen.getByText(/No brands match/)).toBeDefined());
  });

  it('shows a distinct error state (not "no results") when the search request fails', async () => {
    searchMockState.forceError = true;
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    const input = screen.getByPlaceholderText('Search 500+ brands');
    fireEvent.change(input, { target: { value: 'amaz' } });
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeDefined());
    expect(screen.queryByText(/No brands match/)).toBeNull();
  });

  it('does not fire the search request while a query has not been typed', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    expect(searchMockState.lastArgs?.[1]?.enabled).toBe(false);
  });

  it('passes the bounded MOBILE_SEARCH_RESULT_LIMIT (50) once searching', async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText('Browse Only')).toBeDefined());
    const input = screen.getByPlaceholderText('Search 500+ brands');
    fireEvent.change(input, { target: { value: 'amaz' } });
    await waitFor(() => expect(searchMockState.lastArgs?.[1]?.enabled).toBe(true));
    expect(searchMockState.lastArgs?.[1]?.limit).toBe(50);
  });
});
