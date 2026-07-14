// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Order } from '@loop/shared';
import type { UseOrdersResult } from '~/hooks/use-orders';

const { authMock, ordersMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: true },
  // Populated per-test before render(); the route reads whatever this holds.
  ordersMock: { state: {} as UseOrdersResult },
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false }),
}));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { loopOrdersEnabled: false }, isLoading: false }),
}));
vi.mock('~/hooks/use-orders', () => ({
  useOrders: () => ordersMock.state,
}));
vi.mock('~/services/user', () => ({
  getUserPendingPayouts: () => Promise.resolve({ payouts: [] }),
}));

// The lifetime-cashback / flywheel / summary headers and the Loop-native
// list each fire their own queries and are irrelevant to the pending-filter
// pagination trap under test — stub them so the suite stays hermetic and
// focused on the list / empty-state / pagination logic of this route.
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/orders/LoopOrdersList', () => ({ LoopOrdersList: () => null }));
vi.mock('~/components/features/orders/OrdersSummaryHeader', () => ({
  OrdersSummaryHeader: () => null,
}));
vi.mock('~/components/features/cashback/CashbackEarningsHeadline', () => ({
  CashbackEarningsHeadline: () => null,
}));
vi.mock('~/components/features/cashback/FlywheelChip', () => ({ FlywheelChip: () => null }));

import OrdersRoute from '../orders';

function mkOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? 'o-' + Math.random().toString(36).slice(2, 8),
    merchantId: overrides.merchantId ?? 'm-1',
    merchantName: overrides.merchantName ?? 'Acme',
    amount: overrides.amount ?? 10,
    currency: overrides.currency ?? 'USD',
    status: overrides.status ?? 'completed',
    xlmAmount: overrides.xlmAmount ?? '100',
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00.000Z',
  };
}

function mkOrdersResult(overrides: Partial<UseOrdersResult>): UseOrdersResult {
  return {
    orders: [],
    hasNext: false,
    hasPrev: false,
    total: 0,
    totalPages: 0,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
    ...overrides,
  };
}

async function renderPage(): Promise<ReturnType<typeof render>> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OrdersRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Flush the enabled pending-payouts query's resolve so its state update
  // is wrapped in act() (keeps the run output free of act() warnings). The
  // resolved payload is empty, so it doesn't change any assertion below.
  await act(async () => {});
  return result;
}

beforeEach(() => {
  authMock.isAuthenticated = true;
});
afterEach(cleanup);

describe('OrdersRoute — pending-filter pagination trap (AUD-08)', () => {
  it('does NOT show the terminal empty state and DOES keep Next when a page is all-pending but more pages exist', async () => {
    // Server paginates over ALL statuses; this page happens to hold only
    // `pending` orders, which the route hides — but `hasNext` is true, so
    // the user's completed orders live on a later page.
    ordersMock.state = mkOrdersResult({
      orders: [
        mkOrder({ id: 'p-1', status: 'pending' }),
        mkOrder({ id: 'p-2', status: 'pending' }),
      ],
      hasNext: true,
      hasPrev: false,
    });
    await renderPage();

    // The false terminal empty state must be gone — there ARE orders, just
    // none visible on THIS page.
    expect(screen.queryByText('No orders yet.')).toBeNull();

    // Next must be present AND enabled so the user can escape this page.
    const next = screen.getByRole('button', { name: 'Next' });
    expect((next as HTMLButtonElement).disabled).toBe(false);

    // A neutral, non-terminal notice for the current page.
    expect(screen.getByText('No orders on this page.')).toBeTruthy();
  });

  it('keeps Previous available on an all-pending page that has a previous page', async () => {
    ordersMock.state = mkOrdersResult({
      orders: [mkOrder({ id: 'p-3', status: 'pending' })],
      hasNext: false,
      hasPrev: true,
    });
    await renderPage();

    expect(screen.queryByText('No orders yet.')).toBeNull();
    const prev = screen.getByRole('button', { name: 'Previous' });
    expect((prev as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders the visible (non-pending) orders and hides pending rows', async () => {
    ordersMock.state = mkOrdersResult({
      orders: [
        mkOrder({ id: 'c-1', status: 'completed', merchantName: 'Completed Co' }),
        mkOrder({ id: 'p-9', status: 'pending', merchantName: 'Pending Co' }),
      ],
      hasNext: false,
      hasPrev: false,
    });
    await renderPage();

    expect(screen.getByText('Completed Co')).toBeTruthy();
    expect(screen.queryByText('Pending Co')).toBeNull();
    expect(screen.queryByText('No orders yet.')).toBeNull();
    expect(screen.queryByText('No orders on this page.')).toBeNull();
  });

  it('shows the terminal empty state ONLY when there are genuinely no orders and no other pages', async () => {
    ordersMock.state = mkOrdersResult({ orders: [], hasNext: false, hasPrev: false });
    await renderPage();

    expect(screen.getByText('No orders yet.')).toBeTruthy();
    // No pagination and no neutral notice on a genuinely-empty account.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByText('No orders on this page.')).toBeNull();
  });
});
