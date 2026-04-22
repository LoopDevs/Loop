// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { AdminUserFlywheelChip } from '../AdminUserFlywheelChip';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserFlywheelStats: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserFlywheelStats: (userId: string) => adminMock.getAdminUserFlywheelStats(userId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChip(userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminUserFlywheelChip userId={userId} />
    </QueryClientProvider>,
  );
}

describe('<AdminUserFlywheelChip />', () => {
  it('renders the neutral "no recycled orders yet" line for zero-recycled users (NOT silent)', async () => {
    adminMock.getAdminUserFlywheelStats.mockResolvedValue({
      userId: 'u-1',
      currency: 'GBP',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 5,
      totalFulfilledChargeMinor: '20000',
    });
    renderChip('u-1');
    // Operators need to see "nothing yet" explicitly — the chip
    // must NOT self-hide like the user-side variant.
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel: no recycled orders yet/i)).toBeDefined();
    });
  });

  it('renders the green chip with charge + count + percentage for recycled users', async () => {
    adminMock.getAdminUserFlywheelStats.mockResolvedValue({
      userId: 'u-2',
      currency: 'GBP',
      recycledOrderCount: 3,
      recycledChargeMinor: '4500',
      totalFulfilledCount: 10,
      totalFulfilledChargeMinor: '20000',
    });
    renderChip('u-2');
    await waitFor(() => {
      expect(screen.getByLabelText(/Flywheel stats/i)).toBeDefined();
    });
    expect(screen.getByText(/45\.00/)).toBeDefined();
    expect(screen.getByText(/3 orders/)).toBeDefined();
    // 4500 / 20000 → 22.5%.
    expect(screen.getByText(/22\.5% of spend/)).toBeDefined();
  });

  it('uses singular "order" for recycledOrderCount === 1', async () => {
    adminMock.getAdminUserFlywheelStats.mockResolvedValue({
      userId: 'u-3',
      currency: 'USD',
      recycledOrderCount: 1,
      recycledChargeMinor: '500',
      totalFulfilledCount: 4,
      totalFulfilledChargeMinor: '2000',
    });
    renderChip('u-3');
    await waitFor(() => {
      expect(screen.getByText(/1 order\b/)).toBeDefined();
    });
    expect(screen.queryByText(/1 orders/)).toBeNull();
  });

  it('shows an inline red error on non-404 failure (dashboard, not silent)', async () => {
    adminMock.getAdminUserFlywheelStats.mockRejectedValue(new Error('boom'));
    renderChip('u-4');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load flywheel stats/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (user deleted between list and drill)', async () => {
    adminMock.getAdminUserFlywheelStats.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'User not found' }),
    );
    const { container } = renderChip('u-5');
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Flywheel stats"]')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/)).toBeNull();
    expect(screen.queryByText(/No recycled orders yet/)).toBeNull();
  });
});
