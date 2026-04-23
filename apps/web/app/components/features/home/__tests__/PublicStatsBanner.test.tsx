// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PublicModule from '~/services/public';
import { PublicStatsBanner } from '../PublicStatsBanner';

afterEach(cleanup);

const { publicMock } = vi.hoisted(() => ({
  publicMock: {
    getPublicStats: vi.fn(),
  },
}));

vi.mock('~/services/public', async (importActual) => {
  const actual = (await importActual()) as typeof PublicModule;
  return {
    ...actual,
    getPublicStats: () => publicMock.getPublicStats(),
  };
});

function renderBanner(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PublicStatsBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  publicMock.getPublicStats.mockReset();
});

describe('PublicStatsBanner', () => {
  it('renders nothing before the first response arrives', () => {
    publicMock.getPublicStats.mockReturnValue(new Promise(() => {}));
    const { container } = renderBanner();
    expect(container.querySelector('section')).toBeNull();
  });

  it('renders nothing when every aggregate is zero (fresh deployment)', async () => {
    publicMock.getPublicStats.mockResolvedValue({
      paidCashbackMinor: {},
      paidUserCount: '0',
      merchantsWithOrders: '0',
      fulfilledOrderCount: '0',
    });
    const { container } = renderBanner();
    // Microtask flush — query resolves.
    await waitFor(() => {
      // No tiles → no section element.
      expect(container.querySelector('section')).toBeNull();
    });
  });

  it('renders populated tiles with locale-formatted numbers', async () => {
    publicMock.getPublicStats.mockResolvedValue({
      paidCashbackMinor: { GBP: '1234567', USD: '890000' },
      paidUserCount: '1500',
      merchantsWithOrders: '12',
      fulfilledOrderCount: '4200',
    });
    renderBanner();
    await waitFor(() => {
      // GBP formatted with £ and commas
      expect(screen.getByText('£12,345.67')).toBeDefined();
      expect(screen.getByText('$8,900.00')).toBeDefined();
      expect(screen.getByText('1,500')).toBeDefined();
      expect(screen.getByText('12')).toBeDefined();
      expect(screen.getByText('4,200')).toBeDefined();
    });
  });

  it('uses singular labels when a count is 1', async () => {
    publicMock.getPublicStats.mockResolvedValue({
      paidCashbackMinor: { GBP: '100' },
      paidUserCount: '1',
      merchantsWithOrders: '1',
      fulfilledOrderCount: '1',
    });
    renderBanner();
    await waitFor(() => {
      expect(screen.getByText('user earning')).toBeDefined();
      expect(screen.getByText('merchant')).toBeDefined();
      expect(screen.getByText('order fulfilled')).toBeDefined();
    });
  });

  it('preserves bigint precision on huge cashback totals', async () => {
    publicMock.getPublicStats.mockResolvedValue({
      paidCashbackMinor: { USD: '9007199254740993' }, // Number.MAX_SAFE_INTEGER + 2
      paidUserCount: '1000',
      merchantsWithOrders: '100',
      fulfilledOrderCount: '1000000',
    });
    renderBanner();
    await waitFor(() => {
      // Trailing 2 chars are fractional; middle digits must be preserved.
      // 90071992547409.93 is the expected shape — verify the last ".93" didn't drift to ".92".
      expect(screen.getByText(/\$.*\.93$/)).toBeDefined();
    });
  });

  it('orders currencies as GBP, USD, EUR even when the backend returns them in a different order', async () => {
    publicMock.getPublicStats.mockResolvedValue({
      paidCashbackMinor: { EUR: '100', USD: '200', GBP: '300' },
      paidUserCount: '0',
      merchantsWithOrders: '0',
      fulfilledOrderCount: '0',
    });
    renderBanner();
    await waitFor(() => {
      const tileValues = Array.from(document.querySelectorAll('li span:first-child')).map(
        (el) => el.textContent,
      );
      // First three entries are the cashback tiles in GBP, USD, EUR order.
      expect(tileValues.slice(0, 3)).toEqual(['£3.00', '$2.00', '€1.00']);
    });
  });
});
