// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { authMock, configMock, loopListMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: true },
  configMock: {},
  loopListMock: vi.fn<() => React.JSX.Element | null>(),
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false }),
}));
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: configMock, isLoading: false }),
}));
vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/orders/LoopOrdersList', () => ({
  LoopOrdersList: () => loopListMock(),
}));
vi.mock('~/components/features/orders/OrdersSummaryHeader', () => ({
  OrdersSummaryHeader: () => null,
}));
vi.mock('~/components/features/cashback/CashbackEarningsHeadline', () => ({
  CashbackEarningsHeadline: () => null,
}));

import OrdersRoute from '../orders';

async function renderPage(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OrdersRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  loopListMock.mockReset();
  loopListMock.mockReturnValue(<div data-testid="loop-orders-list" />);
});
afterEach(cleanup);

describe('OrdersRoute', () => {
  it('renders the Loop orders list as the only order source when signed in', async () => {
    await renderPage();
    expect(screen.getByTestId('loop-orders-list')).toBeTruthy();
    expect(loopListMock).toHaveBeenCalledOnce();
    expect(screen.queryByText('Sign in to view your order history.')).toBeNull();
  });

  it('shows the signed-out prompt and no list when unauthenticated', async () => {
    authMock.isAuthenticated = false;
    await renderPage();
    expect(screen.getByText('Sign in to view your order history.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(loopListMock).not.toHaveBeenCalled();
  });
});
