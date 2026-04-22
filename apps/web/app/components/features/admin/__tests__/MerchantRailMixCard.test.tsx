// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantRailMixCard } from '../MerchantRailMixCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantPaymentMethodShare: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantPaymentMethodShare: (
      merchantId: string,
      opts?: { state?: AdminModule.AdminOrderState },
    ) => adminMock.getAdminMerchantPaymentMethodShare(merchantId, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MerchantRailMixCard merchantId={merchantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MerchantRailMixCard />', () => {
  it('renders the zero-volume line when totalOrders is 0', async () => {
    adminMock.getAdminMerchantPaymentMethodShare.mockResolvedValue({
      merchantId: 'empty',
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: {
        loop_asset: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        xlm: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderCard('empty');
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders all four rails with counts and both percentage columns', async () => {
    // Totals: 45 orders across rails, 15000 charge.
    // loop_asset: 15 / 45 = 33.3% orders, 6000 / 15000 = 40.0% charge.
    adminMock.getAdminMerchantPaymentMethodShare.mockResolvedValue({
      merchantId: 'mixed',
      state: 'fulfilled',
      totalOrders: 45,
      byMethod: {
        loop_asset: { orderCount: 18, chargeMinor: '6000' },
        credit: { orderCount: 5, chargeMinor: '2000' },
        usdc: { orderCount: 10, chargeMinor: '4000' },
        xlm: { orderCount: 12, chargeMinor: '3000' },
      },
    });
    renderCard('mixed');
    // Wait for the pill link (not header text) so the assertion
    // only passes once the table has rendered. The card header
    // also contains "LOOP asset", so matching plain text would
    // resolve on first render while the table is still loading.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /LOOP asset/i })).toBeDefined();
    });
    expect(screen.getByText('Credit balance')).toBeDefined();
    expect(screen.getByText('USDC')).toBeDefined();
    expect(screen.getByText('XLM')).toBeDefined();
    // Order counts — each is unique so getByText is safe.
    expect(screen.getByText('18')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    // loop_asset — 18 / 45 = 40.0% by count, 6000 / 15000 = 40.0% by charge.
    expect(screen.getAllByText(/40\.0%/).length).toBeGreaterThan(0);
  });

  it('drill links include merchantId + paymentMethod + state=fulfilled', async () => {
    adminMock.getAdminMerchantPaymentMethodShare.mockResolvedValue({
      merchantId: 'amazon_us',
      state: 'fulfilled',
      totalOrders: 1,
      byMethod: {
        loop_asset: { orderCount: 1, chargeMinor: '500' },
        credit: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        xlm: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderCard('amazon_us');
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /LOOP asset/i })).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /LOOP asset/i });
    expect(link.getAttribute('href')).toBe(
      '/admin/orders?merchantId=amazon_us&paymentMethod=loop_asset&state=fulfilled',
    );
  });

  it('shows inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantPaymentMethodShare.mockRejectedValue(new Error('boom'));
    renderCard('broken');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load rail mix/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantPaymentMethodShare.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderCard('evicted');
    await waitFor(() => {
      expect(container.querySelector('table')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });
});
