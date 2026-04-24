// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { OrdersSummaryHeader, formatMinor } from '../OrdersSummaryHeader';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserOrdersSummary: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserOrdersSummary: () => userMock.getUserOrdersSummary(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));

function renderHeader(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersSummaryHeader />
    </QueryClientProvider>,
  );
}

describe('formatMinor', () => {
  it('renders GBP minor as localised currency with no decimals', () => {
    expect(formatMinor('35000', 'GBP')).toMatch(/£350/);
  });

  it('em-dashes on non-numeric input', () => {
    expect(formatMinor('nope', 'GBP')).toBe('—');
  });
});

describe('<OrdersSummaryHeader />', () => {
  it('hides silently on fetch error', async () => {
    userMock.getUserOrdersSummary.mockRejectedValue(new Error('boom'));
    const { container } = renderHeader();
    await waitFor(() => {
      expect(userMock.getUserOrdersSummary).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-label="Orders summary"]')).toBeNull();
  });

  it('hides for zero-activity users (no flash of four zeros)', async () => {
    userMock.getUserOrdersSummary.mockResolvedValue({
      currency: 'GBP',
      totalOrders: 0,
      fulfilledCount: 0,
      pendingCount: 0,
      failedCount: 0,
      totalSpentMinor: '0',
    });
    const { container } = renderHeader();
    await waitFor(() => {
      expect(userMock.getUserOrdersSummary).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-label="Orders summary"]')).toBeNull();
  });

  it('renders Total / Fulfilled / In flight / Spent for an active user', async () => {
    userMock.getUserOrdersSummary.mockResolvedValue({
      currency: 'GBP',
      totalOrders: 12,
      fulfilledCount: 7,
      pendingCount: 3,
      failedCount: 2,
      totalSpentMinor: '35000',
    });
    renderHeader();
    await screen.findByText(/Total/i);
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText(/£350/)).toBeDefined();
  });

  it('applies the in-flight emphasis only when pendingCount > 0', async () => {
    userMock.getUserOrdersSummary.mockResolvedValue({
      currency: 'GBP',
      totalOrders: 5,
      fulfilledCount: 5,
      pendingCount: 0,
      failedCount: 0,
      totalSpentMinor: '10000',
    });
    const { container } = renderHeader();
    await screen.findByText(/Total/i);
    // Active pendingCount=0 — the "In flight" value should NOT be
    // rendered with the yellow emphasis class.
    const pendingValue = container.querySelector('.text-yellow-700, .dark\\:text-yellow-400');
    expect(pendingValue).toBeNull();
  });
});
