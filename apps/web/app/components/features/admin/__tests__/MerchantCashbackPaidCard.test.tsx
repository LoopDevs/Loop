// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantCashbackPaidCard } from '../MerchantCashbackPaidCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantCashbackSummary: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantCashbackSummary: (merchantId: string) =>
      adminMock.getAdminMerchantCashbackSummary(merchantId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MerchantCashbackPaidCard merchantId={merchantId} />
    </QueryClientProvider>,
  );
}

describe('<MerchantCashbackPaidCard />', () => {
  it('renders the zero-volume line when the merchant has no fulfilled orders', async () => {
    adminMock.getAdminMerchantCashbackSummary.mockResolvedValue({
      merchantId: 'empty',
      totalFulfilledCount: 0,
      currencies: [],
    });
    renderCard('empty');
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders per-currency rows with cashback + percentage of spend', async () => {
    adminMock.getAdminMerchantCashbackSummary.mockResolvedValue({
      merchantId: 'multi_ccy',
      totalFulfilledCount: 62,
      currencies: [
        {
          currency: 'USD',
          fulfilledCount: 50,
          // 12.5% of spend (15000 / 120000).
          lifetimeCashbackMinor: '15000',
          lifetimeChargeMinor: '120000',
        },
        {
          currency: 'GBP',
          fulfilledCount: 12,
          // 6.0% of spend (3600 / 60000).
          lifetimeCashbackMinor: '3600',
          lifetimeChargeMinor: '60000',
        },
      ],
    });
    renderCard('multi_ccy');
    await waitFor(() => {
      expect(screen.getByText('USD')).toBeDefined();
    });
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.getByText('50')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    // USD $150.00 and GBP £36.00 — formatMinorCurrency divides by 100.
    expect(screen.getByText(/\$150\.00/)).toBeDefined();
    expect(screen.getByText(/£36\.00/)).toBeDefined();
    expect(screen.getByText(/12\.5%/)).toBeDefined();
    expect(screen.getByText(/6(\.0)?%/)).toBeDefined();
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantCashbackSummary.mockRejectedValue(new Error('boom'));
    renderCard('broken');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load cashback summary/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantCashbackSummary.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderCard('evicted');
    await waitFor(() => {
      // The card's header always renders; but its body should
      // contain no rows and no error line on 404.
      expect(container.querySelector('table')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No fulfilled orders yet/)).toBeNull();
  });
});
