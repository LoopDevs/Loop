// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { UserCashbackByMerchantTable, fmtCashback } from '../UserCashbackByMerchantTable';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserCashbackByMerchant: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserCashbackByMerchant: (userId: string, opts?: unknown) =>
      adminMock.getAdminUserCashbackByMerchant(userId, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function renderTable(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserCashbackByMerchantTable userId={USER_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtCashback (admin variant)', () => {
  it('formats GBP minor as localised currency', () => {
    expect(fmtCashback('12500', 'GBP')).toMatch(/125\.00/);
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtCashback('nope', 'GBP')).toBe('—');
  });
});

describe('<UserCashbackByMerchantTable />', () => {
  it('renders the empty-state copy when the user has no cashback in the window', async () => {
    adminMock.getAdminUserCashbackByMerchant.mockResolvedValue({
      userId: USER_ID,
      currency: 'GBP',
      since: new Date().toISOString(),
      rows: [],
    });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/No cashback earned in the last 180 days/i)).toBeDefined();
    });
  });

  it('renders rows with scoped orders-list drill-down per merchant', async () => {
    adminMock.getAdminUserCashbackByMerchant.mockResolvedValue({
      userId: USER_ID,
      currency: 'GBP',
      since: new Date().toISOString(),
      rows: [
        {
          merchantId: 'amazon_us',
          cashbackMinor: '12500',
          orderCount: 5,
          lastEarnedAt: new Date().toISOString(),
        },
      ],
    });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText('amazon_us')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /orders for amazon_us/i });
    expect(link.getAttribute('href')).toBe(`/admin/orders?merchantId=amazon_us&userId=${USER_ID}`);
    expect(screen.getByText(/\+.*125\.00/)).toBeDefined();
  });

  it('surfaces a red error banner on fetch failure', async () => {
    adminMock.getAdminUserCashbackByMerchant.mockRejectedValue(new Error('boom'));
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load cashback breakdown/i)).toBeDefined();
    });
  });
});
