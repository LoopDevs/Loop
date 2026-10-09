// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import type { Merchant } from '@loop/shared';

const { merchantMock } = vi.hoisted(() => ({
  merchantMock: { current: undefined as Merchant | undefined },
}));

vi.mock('~/hooks/use-merchants', () => ({
  useMerchantBySlug: () => ({ merchant: merchantMock.current, isLoading: false, isError: false }),
  useMerchant: () => ({ merchant: undefined }),
  useMerchantCashbackRate: () => ({ userCashbackPct: null }),
}));
vi.mock('~/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('~/hooks/use-native-platform', () => ({ useNativePlatform: () => ({ isNative: false }) }));
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/Footer', () => ({ Footer: () => null }));
vi.mock('~/components/features/purchase/PurchaseContainer', () => ({
  PurchaseContainer: () => null,
}));
vi.mock('~/components/features/OutsideHomeCountryDialog', () => ({
  OutsideHomeCountryDialog: () => null,
}));

import GiftCardRoute from '../gift-card.$name';

afterEach(cleanup);

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:country/:lang/gift-card/:name" element={<GiftCardRoute />} />
        <Route path="/gift-card/:name" element={<GiftCardRoute />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('GiftCardRoute locale follows the merchant country', () => {
  beforeEach(() => {
    merchantMock.current = { id: 'm-gb', name: 'Shop', country: 'GB', enabled: true };
  });

  it("re-points the URL locale at the merchant's country", async () => {
    renderAt('/pt/en/gift-card/shop-gb?ref=1');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/gb/en/gift-card/shop-gb?ref=1'),
    );
  });

  it("prefixes an unprefixed URL with the merchant's country locale", async () => {
    renderAt('/gift-card/shop-gb');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/gb/en/gift-card/shop-gb'),
    );
  });

  it('leaves the URL alone when it already sits in the merchant country', async () => {
    renderAt('/gb/en/gift-card/shop-gb');
    await screen.findByText('How to redeem');
    expect(screen.getByTestId('location').textContent).toBe('/gb/en/gift-card/shop-gb');
  });

  it('leaves the URL alone for a merchant in an unrouted country', async () => {
    merchantMock.current = { id: 'm-iq', name: 'Shop', country: 'IQ', enabled: true };
    renderAt('/pt/en/gift-card/shop-iq');
    await screen.findByText('How to redeem');
    expect(screen.getByTestId('location').textContent).toBe('/pt/en/gift-card/shop-iq');
  });
});
