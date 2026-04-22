// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { FleetFlywheelHeadline } from '../FleetFlywheelHeadline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getPaymentMethodShare: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getPaymentMethodShare: (opts?: { state?: string }) => adminMock.getPaymentMethodShare(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderHeadline(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FleetFlywheelHeadline />
    </QueryClientProvider>,
  );
}

function emptyBuckets(): {
  xlm: { orderCount: number; chargeMinor: string };
  usdc: { orderCount: number; chargeMinor: string };
  credit: { orderCount: number; chargeMinor: string };
  loop_asset: { orderCount: number; chargeMinor: string };
} {
  return {
    xlm: { orderCount: 0, chargeMinor: '0' },
    usdc: { orderCount: 0, chargeMinor: '0' },
    credit: { orderCount: 0, chargeMinor: '0' },
    loop_asset: { orderCount: 0, chargeMinor: '0' },
  };
}

describe('<FleetFlywheelHeadline />', () => {
  it('silently hides when the fleet has no fulfilled orders yet', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: emptyBuckets(),
    });
    const { container } = renderHeadline();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Fleet flywheel status"]')).toBeNull();
    });
  });

  it('silently hides on fetch error (dashboard-top; not load-bearing)', async () => {
    adminMock.getPaymentMethodShare.mockRejectedValue(new Error('boom'));
    const { container } = renderHeadline();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Fleet flywheel status"]')).toBeNull();
    });
  });

  it('renders a muted "not yet" banner when fulfilled orders exist but zero are loop_asset', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 100,
      byMethod: {
        xlm: { orderCount: 60, chargeMinor: '30000' },
        usdc: { orderCount: 40, chargeMinor: '20000' },
        credit: { orderCount: 0, chargeMinor: '0' },
        loop_asset: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderHeadline();
    await waitFor(() => {
      expect(screen.getByText(/No LOOP-asset paid orders in the last window/i)).toBeDefined();
    });
  });

  it('renders the green chip with % of orders + % of charge on the happy path', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 200,
      byMethod: {
        xlm: { orderCount: 40, chargeMinor: '20000' },
        usdc: { orderCount: 40, chargeMinor: '20000' },
        credit: { orderCount: 20, chargeMinor: '10000' },
        loop_asset: { orderCount: 100, chargeMinor: '50000' },
      },
    });
    renderHeadline();
    await waitFor(() => {
      expect(screen.getByLabelText(/Fleet flywheel status/i)).toBeDefined();
    });
    // 100 / 200 = 50.0% (pctOrders) and 50000 / 100000 = 50.0%
    // (pctCharge) — same value in this fixture, so both segments
    // render the same text. Two cells should match.
    expect(screen.getAllByText(/50\.0%/).length).toBeGreaterThanOrEqual(2);
    // Total-orders count is surfaced.
    expect(screen.getByText('200')).toBeDefined();
  });

  it('returns null when the loop_asset chargeMinor is malformed (defensive)', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 10,
      byMethod: {
        xlm: { orderCount: 5, chargeMinor: '5000' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        loop_asset: { orderCount: 5, chargeMinor: 'not-a-bigint' },
      },
    });
    const { container } = renderHeadline();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Fleet flywheel status"]')).toBeNull();
    });
  });
});
