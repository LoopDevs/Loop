// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { StuckOrderRow } from '~/services/admin';
import AdminStuckOrdersRoute, { ageClass } from '../admin.stuck-orders';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getStuckOrders: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getStuckOrders: () => adminMock.getStuckOrders(),
    getTreasurySnapshot: vi.fn().mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {},
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: {},
      operatorPool: { size: 0, operators: [] },
    }),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminStuckOrdersRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<StuckOrderRow> = {}): StuckOrderRow {
  return {
    id: overrides.id ?? 'aaaaaaaa',
    userId: overrides.userId ?? 'bbbbbbbb',
    merchantId: overrides.merchantId ?? 'mer-stuck',
    state: overrides.state ?? 'paid',
    stuckSince: overrides.stuckSince ?? new Date().toISOString(),
    ageMinutes: overrides.ageMinutes ?? 20,
    ctxOrderId: overrides.ctxOrderId ?? null,
    ctxOperatorId: overrides.ctxOperatorId ?? null,
  };
}

describe('ageClass', () => {
  it('uses yellow for just-over-SLO ages', () => {
    expect(ageClass(20, 15)).toMatch(/yellow/);
  });

  it('uses orange for 2x-SLO ages', () => {
    expect(ageClass(35, 15)).toMatch(/orange/);
  });

  it('uses red for 4x-SLO ages', () => {
    expect(ageClass(65, 15)).toMatch(/red/);
  });
});

describe('<AdminStuckOrdersRoute />', () => {
  it('renders an all-clear card when no stuck rows', async () => {
    adminMock.getStuckOrders.mockResolvedValue({ thresholdMinutes: 15, rows: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/inside the 15-minute SLO/i)).toBeDefined();
    });
  });

  it('renders a table row with a deep link when rows are present', async () => {
    adminMock.getStuckOrders.mockResolvedValue({
      thresholdMinutes: 15,
      rows: [row({ id: 'abcd1234efgh5678', userId: '9999aaaabbbbcccc', ageMinutes: 22 })],
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('abcd1234')).toBeDefined();
    });
    const orderLink = screen.getByRole('link', { name: /abcd1234/ });
    expect(orderLink.getAttribute('href')).toBe('/admin/orders/abcd1234efgh5678');
    expect(screen.getByText('22m')).toBeDefined();
  });

  it('surfaces an error message on fetch failure', async () => {
    adminMock.getStuckOrders.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load stuck orders/)).toBeDefined();
    });
  });
});
