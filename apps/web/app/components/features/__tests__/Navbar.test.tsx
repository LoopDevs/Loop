// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { Navbar } from '../Navbar';

/**
 * UX-05 / UX-06 (docs/ux-pass-2026-07-09.md): the navbar search input
 * needs a real accessible name (not placeholder-only), and a no-match
 * query needs an explicit "no results" state instead of the dropdown
 * silently not rendering.
 */

afterEach(cleanup);

const FIXTURE_MERCHANTS: Merchant[] = [
  { id: 'a', name: 'Amazon', enabled: true, savingsPercentage: 3 },
  { id: 'b', name: 'Aerie', enabled: true, savingsPercentage: 5 },
];

// Stateful flags the individual tests below flip to exercise the
// loading/error branches of `useMerchantSearch` — S4-7 §3 tail
// (go-live-plan §P3): Navbar now calls the server-side search endpoint
// instead of client-filtering the full catalog, so the mock simulates
// the server's filter-by-name behaviour instead of returning a static
// fixture.
const searchMockState = { forceLoading: false, forceError: false };

vi.mock('~/hooks/use-merchants', () => ({
  useMerchantSearch: (query: string, options?: { enabled?: boolean }) => {
    if (options?.enabled === false) {
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
    const merchants = FIXTURE_MERCHANTS.filter((m) => m.name.toLowerCase().includes(q));
    return { merchants, isLoading: false, isFetching: false, isError: false, error: null };
  },
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: false, email: null, logout: vi.fn() }),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({
    config: { phase1Only: true },
    isLoading: false,
  }),
}));

function renderNavbar(path = '/us/en'): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/:country/:lang/*" element={<Navbar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Navbar search', () => {
  afterEach(() => {
    searchMockState.forceLoading = false;
    searchMockState.forceError = false;
  });

  it('gives the search input a real accessible name (UX-05)', () => {
    renderNavbar();
    // getByRole with an accessible-name query fails if the input only has
    // a placeholder — this is the same check the UX-05 finding used to
    // confirm the bug (page.getByLabel couldn't find the field).
    expect(screen.getByRole('textbox', { name: 'Search brands' })).toBeDefined();
  });

  it('shows no dropdown before a query is typed', () => {
    renderNavbar();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows matching results for a real query', async () => {
    renderNavbar();
    const input = screen.getByRole('textbox', { name: 'Search brands' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'amaz' } });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Amazon/ })).toBeDefined();
    });
  });

  it('shows an explicit "no results" state for a query with no matches (UX-06)', async () => {
    renderNavbar();
    const input = screen.getByRole('textbox', { name: 'Search brands' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzzzzznonexistentmerchant' } });
    await waitFor(() => {
      const text = screen.getByRole('status').textContent ?? '';
      expect(text).toMatch(/No brands match/);
      expect(text).toContain('zzzzzznonexistentmerchant');
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not show the no-results state for a too-short query', () => {
    renderNavbar();
    const input = screen.getByRole('textbox', { name: 'Search brands' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'z' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not flash "no results" while the search request is in flight', async () => {
    searchMockState.forceLoading = true;
    renderNavbar();
    const input = screen.getByRole('textbox', { name: 'Search brands' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'amaz' } });
    // Give the 150ms debounce time to elapse — status should still be
    // absent because the request hasn't resolved yet.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a distinct error state when the search request fails', async () => {
    searchMockState.forceError = true;
    renderNavbar();
    const input = screen.getByRole('textbox', { name: 'Search brands' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'amaz' } });
    await waitFor(() => {
      const text = screen.getByRole('status').textContent ?? '';
      expect(text).toMatch(/unavailable/i);
      expect(text).not.toMatch(/No brands match/);
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
