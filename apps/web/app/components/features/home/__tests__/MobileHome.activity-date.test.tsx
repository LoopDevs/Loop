// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { Order } from '@loop/shared';
import { MobileHome } from '../MobileHome';

/**
 * P2-DATE-SWEEP2: the recent-activity timestamp (`formatWhen`) used to format
 * with the HOST default locale (`toLocaleTimeString(undefined, …)` /
 * `toLocaleDateString(undefined, …)`), so a `/de/en` reader saw whatever the
 * server box / `navigator.language` decided rather than the market they chose
 * (ADR 034). The fix threads the active route locale (`useLocaleTag()`) through
 * to the shared `i18n/format#formatDateTime` seam.
 *
 * This pins the TIME branch (a "today" order → "Today · <time>"). Rendered under
 * a fixed route locale of `en-CA`, the time carries en-CA's dotted-lowercase
 * day-period ("1:00 p.m."). That `[ap]\.m\.` token is produced by neither the
 * en-GB (24h, no marker) nor the en-US (uppercase "AM/PM") host default, so the
 * assertion is red unless the *route* locale drives `formatWhen`. Using a
 * "today" instant keeps the assertion timezone-robust: the day-period style is
 * en-CA's regardless of which hour the host TZ lands on.
 *
 * Mock surface mirrors MobileHome.greeting.test.tsx; only `use-orders` (to feed
 * one settled order) and `use-auth` (authenticated) differ.
 */

afterEach(cleanup);

const { authMock, ordersMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: true, email: 'ash@example.com' as string | null },
  ordersMock: { orders: [] as Order[] },
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
  useOrders: () => ({ orders: ordersMock.orders, isLoading: false, isError: false }),
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

function mkOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    merchantId: 'm-1',
    merchantName: 'Acme Cards',
    amount: 25,
    currency: 'CAD',
    status: 'completed',
    xlmAmount: '0',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderHomeAt(country: string, lang: string): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/${country}/${lang}`]}>
        <Routes>
          <Route path="/:country/:lang" element={<MobileHome />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MobileHome /> recent-activity timestamp (P2-DATE-SWEEP2)', () => {
  it('formats the activity time in the active route locale (en-CA dotted day-period)', async () => {
    // A "today" order so `formatWhen` takes the time branch → "Today · <time>".
    ordersMock.orders = [mkOrder({ createdAt: new Date().toISOString() })];
    renderHomeAt('ca', 'en');
    // en-CA renders 12h time with a dotted lowercase day-period ("… a.m."/"p.m.").
    // The host default here (en-GB) is 24h with no marker, and en-US would be
    // uppercase "AM/PM" — so a match proves the route locale drove `formatWhen`.
    const when = await screen.findByText(/^Today · \d{1,2}:\d{2}\s[ap]\.m\.$/);
    expect(when).toBeTruthy();
  });
});
