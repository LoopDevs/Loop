// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { UserCashbackMonthlyChart } from '../UserCashbackMonthlyChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserCashbackMonthly: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserCashbackMonthly: (userId: string) => adminMock.getAdminUserCashbackMonthly(userId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function renderChart(userId = VALID_UUID): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UserCashbackMonthlyChart userId={userId} />
    </QueryClientProvider>,
  );
}

describe('<UserCashbackMonthlyChart />', () => {
  it('renders the neutral empty-state when entries is empty', async () => {
    adminMock.getAdminUserCashbackMonthly.mockResolvedValue({
      userId: VALID_UUID,
      entries: [],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No cashback earned in the last 12 months yet/i)).toBeDefined();
    });
  });

  it('groups entries by currency and renders month + formatted amount per row', async () => {
    adminMock.getAdminUserCashbackMonthly.mockResolvedValue({
      userId: VALID_UUID,
      entries: [
        { month: '2026-03', currency: 'GBP', cashbackMinor: '4500' }, // £45
        { month: '2026-04', currency: 'GBP', cashbackMinor: '9000' }, // £90
        { month: '2026-04', currency: 'USD', cashbackMinor: '1200' }, // $12
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText('GBP')).toBeDefined();
    });
    expect(screen.getByText('USD')).toBeDefined();
    expect(screen.getByText('£45')).toBeDefined();
    expect(screen.getByText('£90')).toBeDefined();
    expect(screen.getByText('$12')).toBeDefined();
  });

  it('shows an inline red error on non-404 failure', async () => {
    adminMock.getAdminUserCashbackMonthly.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load monthly cashback/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (user deleted between list and drill)', async () => {
    adminMock.getAdminUserCashbackMonthly.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'User not found' }),
    );
    const { container } = renderChart();
    await waitFor(() => {
      expect(container.querySelector('ul')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No cashback earned/)).toBeNull();
  });
});
