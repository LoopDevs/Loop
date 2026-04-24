// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as AdminModule from '~/services/admin';
import AdminOperatorDetailRoute from '../admin.operators.$operatorId';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getOperatorStats: vi.fn(),
    getOperatorLatency: vi.fn(),
    getOperatorSupplierSpend: vi.fn(),
    getOperatorActivity: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getOperatorStats: () => adminMock.getOperatorStats(),
    getOperatorLatency: () => adminMock.getOperatorLatency(),
    getOperatorSupplierSpend: (id: string) => adminMock.getOperatorSupplierSpend(id),
    getOperatorActivity: (id: string, opts?: unknown) => adminMock.getOperatorActivity(id, opts),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// A2-1101: RequireAdmin gates the admin shell on /api/users/me.isAdmin.
import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'u1',
      email: 'admin@loop.test',
      isAdmin: true,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderAt(path = '/admin/operators/op-alpha-01'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/operators/:operatorId" element={<AdminOperatorDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AdminOperatorDetailRoute />', () => {
  it('shows a sign-in prompt when unauthenticated', () => {
    authMock.isAuthenticated = false;
    try {
      renderAt();
      expect(screen.getByText(/Sign in with an admin account/i)).toBeDefined();
    } finally {
      authMock.isAuthenticated = true;
    }
  });

  it('renders every section with the happy-path data', async () => {
    adminMock.getOperatorStats.mockResolvedValue({
      since: '2026-04-22T01:00:00.000Z',
      rows: [
        {
          operatorId: 'op-alpha-01',
          orderCount: 42,
          fulfilledCount: 40,
          failedCount: 2,
          lastOrderAt: '2026-04-22T11:00:00.000Z',
        },
      ],
    });
    adminMock.getOperatorLatency.mockResolvedValue({
      since: '2026-04-22T01:00:00.000Z',
      rows: [
        {
          operatorId: 'op-alpha-01',
          sampleCount: 40,
          p50Ms: 1450,
          p95Ms: 8200,
          p99Ms: 19500,
          meanMs: 3100,
        },
      ],
    });
    adminMock.getOperatorSupplierSpend.mockResolvedValue({
      operatorId: 'op-alpha-01',
      since: '2026-04-22T01:00:00.000Z',
      rows: [
        {
          currency: 'USD',
          count: 30,
          faceValueMinor: '150000',
          wholesaleMinor: '144000',
          userCashbackMinor: '4500',
          loopMarginMinor: '1500',
        },
      ],
    });
    adminMock.getOperatorActivity.mockResolvedValue({
      operatorId: 'op-alpha-01',
      windowDays: 30,
      days: [
        { day: '2026-04-21', created: 20, fulfilled: 18, failed: 2 },
        { day: '2026-04-22', created: 22, fulfilled: 22, failed: 0 },
      ],
    });
    renderAt();

    await waitFor(() => {
      expect(screen.getByText('op-alpha-01')).toBeDefined();
    });

    // Header links to the orders drill for this operator.
    const ordersLink = screen.getByRole('link', {
      name: /Orders carried by this operator/i,
    });
    expect(ordersLink.getAttribute('href')).toBe('/admin/orders?ctxOperatorId=op-alpha-01');

    // Stats metrics — orderCount=42, fulfilled=40 both appear. Use
    // getAllByText since the fulfilled column could coincide with
    // values elsewhere (the samples count in latency is also 40).
    await waitFor(() => {
      expect(screen.getByText('42')).toBeDefined(); // orderCount is unique
    });
    expect(screen.getAllByText('40').length).toBeGreaterThanOrEqual(1);

    // Latency metrics — p95 8200 ms = "8.2 s".
    await waitFor(() => {
      expect(screen.getByText('8.2 s')).toBeDefined();
    });

    // Supplier-spend table renders the wholesale row.
    await waitFor(() => {
      expect(screen.getByText('$1,440.00')).toBeDefined();
    });

    // Activity chart has an aria-label for Apr 22.
    await waitFor(() => {
      expect(screen.getByLabelText(/Apr 22: 22 created, 22 fulfilled, 0 failed/i)).toBeDefined();
    });
  });

  it('renders an empty-stats fallback when the operator has no 24h rows', async () => {
    adminMock.getOperatorStats.mockResolvedValue({ since: '', rows: [] });
    adminMock.getOperatorLatency.mockResolvedValue({ since: '', rows: [] });
    adminMock.getOperatorSupplierSpend.mockResolvedValue({
      operatorId: 'op-solo',
      since: '',
      rows: [],
    });
    adminMock.getOperatorActivity.mockResolvedValue({
      operatorId: 'op-solo',
      windowDays: 30,
      days: [],
    });
    renderAt('/admin/operators/op-solo');
    await waitFor(() => {
      expect(screen.getByText(/No orders in the last 24 hours/i)).toBeDefined();
    });
    expect(screen.getByText(/no latency sample/i)).toBeDefined();
    expect(screen.getByText(/no supplier spend to show/i)).toBeDefined();
    expect(screen.getByText(/No orders for this operator in the last 30 days/i)).toBeDefined();
  });
});
