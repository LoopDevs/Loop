// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantTopEarnersCard } from '../MerchantTopEarnersCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantTopEarners: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantTopEarners: (merchantId: string, opts?: { days?: number; limit?: number }) =>
      adminMock.getAdminMerchantTopEarners(merchantId, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MerchantTopEarnersCard merchantId={merchantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MerchantTopEarnersCard />', () => {
  it('renders the neutral empty-state when no earners in the window', async () => {
    adminMock.getAdminMerchantTopEarners.mockResolvedValue({
      merchantId: 'empty',
      since: new Date().toISOString(),
      rows: [],
    });
    renderCard('empty');
    await waitFor(() => {
      expect(screen.getByText(/No earners at this merchant/i)).toBeDefined();
    });
  });

  it('renders ranked rows with email link, currency, count, formatted cashback', async () => {
    adminMock.getAdminMerchantTopEarners.mockResolvedValue({
      merchantId: 'amazon_us',
      since: new Date().toISOString(),
      rows: [
        {
          userId: 'u-1',
          email: 'whale@example.com',
          currency: 'USD',
          orderCount: 20,
          cashbackMinor: '45000',
          chargeMinor: '900000',
        },
        {
          userId: 'u-2',
          email: 'fin@example.com',
          currency: 'USD',
          orderCount: 5,
          cashbackMinor: '12000',
          chargeMinor: '240000',
        },
      ],
    });
    renderCard('amazon_us');
    await waitFor(() => {
      expect(screen.getByText('whale@example.com')).toBeDefined();
    });
    expect(screen.getByText('fin@example.com')).toBeDefined();
    // Rank column: rendered as "1", "2".
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    // 45000 pence = $450.00, 12000 = $120.00.
    expect(screen.getByText('$450.00')).toBeDefined();
    expect(screen.getByText('$120.00')).toBeDefined();
    // Email renders as a drill-down link.
    const link = screen.getByRole('link', { name: /Open drill-down for whale@example.com/i });
    expect(link.getAttribute('href')).toBe('/admin/users/u-1');
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantTopEarners.mockRejectedValue(new Error('boom'));
    renderCard('broken');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load top earners/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantTopEarners.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderCard('evicted');
    await waitFor(() => {
      // Card header always renders; table/empty line don't.
      expect(container.querySelector('table')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No earners/)).toBeNull();
  });

  it('handles malformed cashback bigint by rendering em-dash without tearing the row down', async () => {
    adminMock.getAdminMerchantTopEarners.mockResolvedValue({
      merchantId: 'broken_row',
      since: new Date().toISOString(),
      rows: [
        {
          userId: 'u-1',
          email: 'broken@example.com',
          currency: 'USD',
          orderCount: 3,
          cashbackMinor: 'not-a-bigint',
          chargeMinor: '0',
        },
      ],
    });
    renderCard('broken_row');
    await waitFor(() => {
      expect(screen.getByText('broken@example.com')).toBeDefined();
    });
    // Rank + email + currency + count still render.
    expect(screen.getByText('USD')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    // Cashback cell falls back to em-dash.
    expect(screen.getByText('—')).toBeDefined();
  });
});
