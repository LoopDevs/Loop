// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantFlywheelActivityChart } from '../MerchantFlywheelActivityChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantFlywheelActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantFlywheelActivity: (merchantId: string, days?: number) =>
      adminMock.getAdminMerchantFlywheelActivity(merchantId, days),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(merchantId = 'amazon_us'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MerchantFlywheelActivityChart merchantId={merchantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MerchantFlywheelActivityChart />', () => {
  it('renders the neutral empty-state line when the series has zero fulfilled orders', async () => {
    // Backend zero-fills every day even for zero-volume merchants,
    // so rows.length > 0 but every count is 0.
    adminMock.getAdminMerchantFlywheelActivity.mockResolvedValue({
      merchantId: 'empty',
      days: 30,
      rows: Array.from({ length: 30 }, (_, i) => ({
        day: `2026-04-${String(i + 1).padStart(2, '0')}`,
        recycledCount: 0,
        totalCount: 0,
        recycledChargeMinor: '0',
        totalChargeMinor: '0',
      })),
    });
    renderChart('empty');
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel activity: no fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders sparkline + subtitle with recycled / total / % once data lands', async () => {
    adminMock.getAdminMerchantFlywheelActivity.mockResolvedValue({
      merchantId: 'amazon_us',
      days: 3,
      rows: [
        {
          day: '2026-04-20',
          recycledCount: 2,
          totalCount: 10,
          recycledChargeMinor: '5000',
          totalChargeMinor: '25000',
        },
        {
          day: '2026-04-21',
          recycledCount: 3,
          totalCount: 10,
          recycledChargeMinor: '7500',
          totalChargeMinor: '25000',
        },
        {
          day: '2026-04-22',
          recycledCount: 5,
          totalCount: 10,
          recycledChargeMinor: '12500',
          totalChargeMinor: '25000',
        },
      ],
    });
    renderChart('amazon_us');
    await waitFor(() => {
      // 10 recycled / 30 total → 33.3%.
      expect(screen.getByText(/10 \/ 30 recycled · 33\.3%/)).toBeDefined();
    });
    // Sparkline aria-label.
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toMatch(/10 of 30 fulfilled orders/);
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminMerchantFlywheelActivity.mockRejectedValue(new Error('boom'));
    renderChart('broken');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load flywheel activity/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (merchant evicted between list and drill)', async () => {
    adminMock.getAdminMerchantFlywheelActivity.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Merchant not found' }),
    );
    const { container } = renderChart('evicted');
    await waitFor(() => {
      // Component returns null — no sparkline, no error text.
      expect(container.querySelector('svg')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No fulfilled orders/)).toBeNull();
  });
});
