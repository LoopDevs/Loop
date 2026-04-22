// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantCashbackMonthlyChart } from '../MerchantCashbackMonthlyChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantCashbackMonthly: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantCashbackMonthly: (merchantId: string) =>
      adminMock.getAdminMerchantCashbackMonthly(merchantId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MerchantCashbackMonthlyChart merchantId={merchantId} />
    </QueryClientProvider>,
  );
}

describe('<MerchantCashbackMonthlyChart />', () => {
  it('renders the empty-state line when entries is empty', async () => {
    adminMock.getAdminMerchantCashbackMonthly.mockResolvedValue({
      merchantId: 'empty',
      entries: [],
    });
    renderChart('empty');
    await waitFor(() => {
      expect(
        screen.getByText(/No cashback minted on fulfilled orders at this merchant/i),
      ).toBeDefined();
    });
  });

  it('groups entries by currency and renders month + formatted amount per row', async () => {
    adminMock.getAdminMerchantCashbackMonthly.mockResolvedValue({
      merchantId: 'multi_ccy',
      entries: [
        { month: '2026-03', currency: 'USD', cashbackMinor: '15000' }, // $150
        { month: '2026-04', currency: 'USD', cashbackMinor: '18000' }, // $180
        { month: '2026-04', currency: 'GBP', cashbackMinor: '4500' }, // £45
      ],
    });
    renderChart('multi_ccy');
    await waitFor(() => {
      expect(screen.getByText('USD')).toBeDefined();
    });
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.getByText('$150')).toBeDefined();
    expect(screen.getByText('$180')).toBeDefined();
    expect(screen.getByText('£45')).toBeDefined();
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantCashbackMonthly.mockRejectedValue(new Error('boom'));
    renderChart('broken');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load monthly cashback/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantCashbackMonthly.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderChart('evicted');
    await waitFor(() => {
      expect(container.querySelector('ul')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No cashback minted/)).toBeNull();
  });
});
