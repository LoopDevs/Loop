// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { TopUsersByPendingPayoutCard, fmtStroops } from '../TopUsersByPendingPayoutCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getTopUsersByPendingPayout: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTopUsersByPendingPayout: (opts?: { limit?: number }) =>
      adminMock.getTopUsersByPendingPayout(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TopUsersByPendingPayoutCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtStroops', () => {
  it('strips trailing zeros and appends the asset code', () => {
    expect(fmtStroops('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('renders whole numbers without a decimal', () => {
    expect(fmtStroops('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('falls back to em-dash on BigInt parse failure', () => {
    expect(fmtStroops('garbage', 'EURLOOP')).toBe('—');
  });
});

describe('<TopUsersByPendingPayoutCard />', () => {
  it('shows empty state when no users are owed anything', async () => {
    adminMock.getTopUsersByPendingPayout.mockResolvedValue({ entries: [] });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No in-flight payouts right now/i)).toBeDefined();
    });
  });

  it('shows error state on fetch failure', async () => {
    adminMock.getTopUsersByPendingPayout.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load top-users-by-pending-payout/i)).toBeDefined();
    });
  });

  it('renders a row per (user, asset) with drill-down links', async () => {
    adminMock.getTopUsersByPendingPayout.mockResolvedValue({
      entries: [
        {
          userId: 'u-1',
          email: 'alice@example.com',
          assetCode: 'USDLOOP',
          totalStroops: '500000000',
          payoutCount: 5,
        },
        {
          userId: 'u-1',
          email: 'alice@example.com',
          assetCode: 'GBPLOOP',
          totalStroops: '100000000',
          payoutCount: 2,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getAllByText('alice@example.com')).toHaveLength(2);
    });
    expect(screen.getByText('50 USDLOOP')).toBeDefined();
    expect(screen.getByText('10 GBPLOOP')).toBeDefined();
    // User-detail links
    const userLinks = screen.getAllByRole('link', {
      name: /Open user detail for alice@example.com/i,
    });
    expect(userLinks).toHaveLength(2);
    expect(userLinks[0]?.getAttribute('href')).toBe('/admin/users/u-1');
    // Payout-count links drill to the asset-filtered list
    const usdlLink = screen.getByRole('link', { name: /Review in-flight USDLOOP payouts/i });
    expect(usdlLink.getAttribute('href')).toBe('/admin/payouts?assetCode=USDLOOP');
    const gbplLink = screen.getByRole('link', { name: /Review in-flight GBPLOOP payouts/i });
    expect(gbplLink.getAttribute('href')).toBe('/admin/payouts?assetCode=GBPLOOP');
  });
});
