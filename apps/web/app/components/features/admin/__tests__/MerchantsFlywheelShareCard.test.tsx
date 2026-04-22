// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { MerchantsFlywheelShareCard } from '../MerchantsFlywheelShareCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminMerchantsFlywheelShare: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminMerchantsFlywheelShare: (opts?: { since?: string; limit?: number }) =>
      adminMock.getAdminMerchantsFlywheelShare(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MerchantsFlywheelShareCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('<MerchantsFlywheelShareCard />', () => {
  it('renders the empty-state line when no merchants have recycled orders yet', async () => {
    adminMock.getAdminMerchantsFlywheelShare.mockResolvedValue({
      since: '2026-03-22T00:00:00.000Z',
      rows: [],
    });
    renderCard();
    await waitFor(() => {
      expect(
        screen.getByText(/No merchants with recycled-cashback orders in the last 31 days/i),
      ).toBeDefined();
    });
  });

  it('silently hides on fetch error (leaderboard — not load-bearing)', async () => {
    adminMock.getAdminMerchantsFlywheelShare.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      // Component returns null on error; the wrapping <MemoryRouter>
      // still produces markup, but no table should appear.
      expect(container.querySelector('table')).toBeNull();
    });
  });

  it('renders one row per merchant with counts + percentages', async () => {
    adminMock.getAdminMerchantsFlywheelShare.mockResolvedValue({
      since: '2026-03-22T00:00:00.000Z',
      rows: [
        {
          merchantId: 'amazon_us',
          totalFulfilledCount: 50,
          recycledOrderCount: 20,
          recycledChargeMinor: '80000',
          totalChargeMinor: '200000',
        },
        {
          merchantId: 'starbucks_uk',
          totalFulfilledCount: 30,
          recycledOrderCount: 12,
          recycledChargeMinor: '36000',
          totalChargeMinor: '90000',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('amazon_us')).toBeDefined();
    });
    expect(screen.getByText('starbucks_uk')).toBeDefined();
    // Recycled + total counts are locale-formatted with thousands
    // separators above 999, but with these fixtures the rendered
    // strings are the raw numbers.
    expect(screen.getByText('20')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getByText('50')).toBeDefined();
    expect(screen.getByText('30')).toBeDefined();
    // % orders: 20/50 = 40.0, 12/30 = 40.0 — both rows the same
    // rounded value, so assert count rather than uniqueness.
    expect(screen.getAllByText('40.0%').length).toBeGreaterThanOrEqual(2);
  });

  it('deep-links each merchant to /admin/orders with loop_asset + fulfilled preset', async () => {
    adminMock.getAdminMerchantsFlywheelShare.mockResolvedValue({
      since: '2026-03-22T00:00:00.000Z',
      rows: [
        {
          merchantId: 'amazon_us',
          totalFulfilledCount: 10,
          recycledOrderCount: 4,
          recycledChargeMinor: '1000',
          totalChargeMinor: '5000',
        },
      ],
    });
    renderCard();
    const link = (await screen.findByText('amazon_us')).closest('a');
    expect(link?.getAttribute('href')).toBe(
      '/admin/orders?merchantId=amazon_us&paymentMethod=loop_asset&state=fulfilled',
    );
  });

  it('renders em-dash in % charge when bigint parsing fails (defensive)', async () => {
    adminMock.getAdminMerchantsFlywheelShare.mockResolvedValue({
      since: '2026-03-22T00:00:00.000Z',
      rows: [
        {
          merchantId: 'bad_merchant',
          totalFulfilledCount: 3,
          recycledOrderCount: 1,
          recycledChargeMinor: 'not-a-bigint',
          totalChargeMinor: '100',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('bad_merchant')).toBeDefined();
    });
    // The % orders column (1/3 = 33.3%) renders correctly; only the
    // % charge column falls back to em-dash.
    expect(screen.getByText('33.3%')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
  });
});
