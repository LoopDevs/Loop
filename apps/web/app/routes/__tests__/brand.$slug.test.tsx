// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { merchantSlug } from '@loop/shared';

const { merchantsMock } = vi.hoisted(() => ({
  merchantsMock: { list: [] as Merchant[], isLoading: false, isError: false },
}));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({
    merchants: merchantsMock.list,
    isLoading: merchantsMock.isLoading,
    isError: merchantsMock.isError,
  }),
  useMerchantsCashbackRatesMap: () => ({ lookup: () => null }),
}));
vi.mock('~/hooks/use-native-platform', () => ({ useNativePlatform: () => ({ isNative: false }) }));
// Navbar/Footer pull in auth/config hooks irrelevant to this route's behaviour.
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/Footer', () => ({ Footer: () => null }));

import BrandRoute from '../brand.$slug';

afterEach(cleanup);

const m = (id: string, name: string): Merchant => ({ id, name, enabled: true });

function renderAt(slug: string): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/brand/${slug}`]}>
        <Routes>
          <Route path="/brand/:slug" element={<BrandRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BrandRoute (ADR 032)', () => {
  beforeEach(() => {
    merchantsMock.list = [
      m('a', 'dots.eco - Plant a Tree'),
      m('b', 'dots.eco - Buy Land'),
      m('c', 'Greggs'),
    ];
    merchantsMock.isLoading = false;
    merchantsMock.isError = false;
  });

  it('renders the brand header + variant labels (not full names) for a group', () => {
    renderAt(merchantSlug('dots.eco'));
    expect(screen.getByRole('heading', { name: 'dots.eco' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Plant a Tree' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Buy Land' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /dots\.eco - / })).toBeNull();
  });

  it('shows the option count', () => {
    renderAt(merchantSlug('dots.eco'));
    expect(screen.getByText(/2 gift card options/)).toBeDefined();
  });

  it('does not surface an unrelated brand', () => {
    renderAt(merchantSlug('dots.eco'));
    expect(screen.queryByRole('heading', { name: 'Greggs' })).toBeNull();
  });

  it('shows a not-found state for an unknown brand slug', () => {
    renderAt('no-such-brand');
    expect(screen.getByText(/Brand not found/)).toBeDefined();
  });
});
