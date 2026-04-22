// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantFlywheelChip } from '../MerchantFlywheelChip';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantFlywheelStats: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantFlywheelStats: (merchantId: string) =>
      adminMock.getAdminMerchantFlywheelStats(merchantId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChip(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MerchantFlywheelChip merchantId={merchantId} />
    </QueryClientProvider>,
  );
}

describe('<MerchantFlywheelChip />', () => {
  it('renders the zero-volume line when the merchant has no fulfilled orders (not silent)', async () => {
    adminMock.getAdminMerchantFlywheelStats.mockResolvedValue({
      merchantId: 'catalog_only',
      since: new Date().toISOString(),
      totalFulfilledCount: 0,
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalChargeMinor: '0',
    });
    renderChip('catalog_only');
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel: no fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders the "no recycled yet" line for merchants with fulfilled volume but no loop_asset orders', async () => {
    adminMock.getAdminMerchantFlywheelStats.mockResolvedValue({
      merchantId: 'xlm_only',
      since: new Date().toISOString(),
      totalFulfilledCount: 8,
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalChargeMinor: '40000',
    });
    renderChip('xlm_only');
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel: no recycled orders yet/i)).toBeDefined();
    });
    expect(screen.getByText(/8 fulfilled/i)).toBeDefined();
  });

  it('renders the green chip with counts + by-count + by-charge percentages', async () => {
    adminMock.getAdminMerchantFlywheelStats.mockResolvedValue({
      merchantId: 'recycling_merchant',
      since: new Date().toISOString(),
      totalFulfilledCount: 40,
      recycledOrderCount: 10,
      // 9000 / 36000 = 25.0% by charge.
      recycledChargeMinor: '9000',
      totalChargeMinor: '36000',
    });
    renderChip('recycling_merchant');
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel stats/i)).toBeDefined();
    });
    expect(screen.getByText(/10 recycled/)).toBeDefined();
    expect(screen.getByText(/40 fulfilled/)).toBeDefined();
    // 10/40 = 25.0% by count.
    expect(screen.getByText(/25\.0% by count/)).toBeDefined();
    expect(screen.getByText(/25(\.0)?% by charge/)).toBeDefined();
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantFlywheelStats.mockRejectedValue(new Error('boom'));
    renderChip('broken_merchant');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load flywheel stats/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantFlywheelStats.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderChip('evicted_merchant');
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Flywheel stats"]')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No fulfilled/)).toBeNull();
    expect(screen.queryByText(/No recycled/)).toBeNull();
  });
});
