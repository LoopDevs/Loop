// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { UserRailMixCard } from '../UserRailMixCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserPaymentMethodShare: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserPaymentMethodShare: (
      userId: string,
      opts?: { state?: AdminModule.AdminOrderState },
    ) => adminMock.getAdminUserPaymentMethodShare(userId, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function renderCard(userId = VALID_UUID): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserRailMixCard userId={userId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<UserRailMixCard />', () => {
  it('renders the zero-volume line when the user has no fulfilled orders', async () => {
    adminMock.getAdminUserPaymentMethodShare.mockResolvedValue({
      userId: VALID_UUID,
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: {
        loop_asset: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        xlm: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders all four rails with counts and both percentage columns', async () => {
    // Totals: 20 orders across rails, 8000 charge.
    // loop_asset: 10 / 20 = 50.0% by count, 4000 / 8000 = 50.0% by charge.
    adminMock.getAdminUserPaymentMethodShare.mockResolvedValue({
      userId: VALID_UUID,
      state: 'fulfilled',
      totalOrders: 20,
      byMethod: {
        loop_asset: { orderCount: 10, chargeMinor: '4000' },
        credit: { orderCount: 3, chargeMinor: '1200' },
        usdc: { orderCount: 5, chargeMinor: '2000' },
        xlm: { orderCount: 2, chargeMinor: '800' },
      },
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /LOOP asset/i })).toBeDefined();
    });
    expect(screen.getByText('Credit balance')).toBeDefined();
    expect(screen.getByText('USDC')).toBeDefined();
    expect(screen.getByText('XLM')).toBeDefined();
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getAllByText(/50\.0%/).length).toBeGreaterThan(0);
  });

  it('drill links include userId + paymentMethod + state=fulfilled', async () => {
    adminMock.getAdminUserPaymentMethodShare.mockResolvedValue({
      userId: VALID_UUID,
      state: 'fulfilled',
      totalOrders: 1,
      byMethod: {
        loop_asset: { orderCount: 1, chargeMinor: '500' },
        credit: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        xlm: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /LOOP asset/i })).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /LOOP asset/i });
    expect(link.getAttribute('href')).toBe(
      `/admin/orders?userId=${VALID_UUID}&paymentMethod=loop_asset&state=fulfilled`,
    );
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminUserPaymentMethodShare.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load rail mix/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (user deleted between list and drill)', async () => {
    adminMock.getAdminUserPaymentMethodShare.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'User not found' }),
    );
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('table')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });
});
