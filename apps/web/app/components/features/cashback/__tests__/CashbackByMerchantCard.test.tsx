// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as UserModule from '~/services/user';
import { CashbackByMerchantCard, fmtCashback } from '../CashbackByMerchantCard';

afterEach(cleanup);

const { userMock, merchantsMock } = vi.hoisted(() => ({
  userMock: {
    getCashbackByMerchant: vi.fn(),
  },
  merchantsMock: {
    merchants: [
      { id: 'amazon_us', name: 'Amazon US', enabled: true },
      { id: 'apple', name: 'Apple', enabled: true },
    ],
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getCashbackByMerchant: () => userMock.getCashbackByMerchant(),
  };
});

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: merchantsMock.merchants }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CashbackByMerchantCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtCashback', () => {
  it('formats GBP minor as localised currency', () => {
    expect(fmtCashback('12500', 'GBP')).toMatch(/125\.00/);
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtCashback('nope', 'GBP')).toBe('—');
  });
});

describe('<CashbackByMerchantCard />', () => {
  it('hides itself silently when the user has no rows', async () => {
    userMock.getCashbackByMerchant.mockResolvedValue({
      currency: 'GBP',
      since: new Date().toISOString(),
      rows: [],
    });
    const { container } = renderCard();
    // Wait for the query to settle + the pending-spinner section to
    // stop rendering — only then is the null-hide branch observable.
    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });

  it('renders one row per merchant with a gift-card link + order count', async () => {
    userMock.getCashbackByMerchant.mockResolvedValue({
      currency: 'GBP',
      since: new Date().toISOString(),
      rows: [
        {
          merchantId: 'amazon_us',
          cashbackMinor: '12500',
          orderCount: 5,
          lastEarnedAt: new Date().toISOString(),
        },
        {
          merchantId: 'apple',
          cashbackMinor: '4200',
          orderCount: 1,
          lastEarnedAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Amazon US')).toBeDefined();
    });
    const amazonLink = screen.getByRole('link', { name: 'Amazon US' });
    expect(amazonLink.getAttribute('href')).toBe('/gift-card/amazon-us');
    expect(screen.getByText('5 orders')).toBeDefined();
    expect(screen.getByText('1 order')).toBeDefined();
    expect(screen.getByText(/\+.*125\.00/)).toBeDefined();
  });

  it('falls back to the raw merchantId when the catalog has no match', async () => {
    userMock.getCashbackByMerchant.mockResolvedValue({
      currency: 'GBP',
      since: new Date().toISOString(),
      rows: [
        {
          merchantId: 'legacy_merchant_removed',
          cashbackMinor: '100',
          orderCount: 1,
          lastEarnedAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('legacy_merchant_removed')).toBeDefined();
    });
  });

  it('hides itself silently on fetch error', async () => {
    userMock.getCashbackByMerchant.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });
});
