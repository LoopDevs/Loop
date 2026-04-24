// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as AdminModule from '~/services/admin';
import AdminOperatorsIndexRoute, { combineRows } from '../admin.operators';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getOperatorStats: vi.fn(),
    getOperatorLatency: vi.fn(),
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getOperatorStats: () => adminMock.getOperatorStats(),
    getOperatorLatency: () => adminMock.getOperatorLatency(),
    getTreasurySnapshot: vi.fn().mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {},
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: { pending: '0', submitted: '0', confirmed: '0', failed: '0' },
      operatorPool: { size: 0, operators: [] },
    }),
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

function renderAt(path = '/admin/operators'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/operators" element={<AdminOperatorsIndexRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('combineRows', () => {
  it('joins stats + latency on operatorId with null latency when missing', () => {
    const result = combineRows(
      [
        {
          operatorId: 'op-alpha-01',
          orderCount: 10,
          fulfilledCount: 9,
          failedCount: 1,
          lastOrderAt: '2026-04-22T10:00:00.000Z',
        },
        {
          operatorId: 'op-beta-02',
          orderCount: 3,
          fulfilledCount: 3,
          failedCount: 0,
          lastOrderAt: '2026-04-22T09:00:00.000Z',
        },
      ],
      [
        {
          operatorId: 'op-alpha-01',
          sampleCount: 9,
          p50Ms: 1450,
          p95Ms: 8200,
          p99Ms: 19500,
          meanMs: 3100,
        },
      ],
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.operatorId).toBe('op-alpha-01'); // failedCount>0 wins over orderCount
    expect(result[0]!.p50Ms).toBe(1450);
    expect(result[1]!.operatorId).toBe('op-beta-02');
    expect(result[1]!.p50Ms).toBeNull(); // no latency row → null
  });

  it('sorts by failedCount DESC, then orderCount DESC, then id ASC', () => {
    const rows = combineRows(
      [
        { operatorId: 'a', orderCount: 5, fulfilledCount: 5, failedCount: 0, lastOrderAt: '' },
        { operatorId: 'c', orderCount: 10, fulfilledCount: 9, failedCount: 1, lastOrderAt: '' },
        { operatorId: 'b', orderCount: 10, fulfilledCount: 9, failedCount: 1, lastOrderAt: '' },
      ],
      [],
    );
    expect(rows.map((r) => r.operatorId)).toEqual(['b', 'c', 'a']);
  });
});

describe('<AdminOperatorsIndexRoute />', () => {
  it('shows a sign-in prompt when unauthenticated', () => {
    authMock.isAuthenticated = false;
    try {
      renderAt();
      expect(screen.getByText(/Sign in with an admin account/i)).toBeDefined();
    } finally {
      authMock.isAuthenticated = true;
    }
  });

  it('renders operator rows with drill links', async () => {
    adminMock.getOperatorStats.mockResolvedValue({
      since: '',
      rows: [
        {
          operatorId: 'op-alpha-01',
          orderCount: 42,
          fulfilledCount: 40,
          failedCount: 2,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    adminMock.getOperatorLatency.mockResolvedValue({
      since: '',
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
    renderAt();

    await waitFor(() => {
      expect(screen.getByText('op-alpha-01')).toBeDefined();
    });

    // Operator name link drills into the detail page.
    const detail = screen.getByRole('link', { name: /open operator detail for op-alpha-01/i });
    expect(detail.getAttribute('href')).toBe('/admin/operators/op-alpha-01');

    // Failed-count cell retains the incident-triage shortcut.
    const failedLink = screen.getByRole('link', {
      name: /review 2 failed orders on op-alpha-01/i,
    });
    expect(failedLink.getAttribute('href')).toBe(
      '/admin/orders?state=failed&ctxOperatorId=op-alpha-01',
    );

    // p95 latency is rendered in seconds (8200 ms → "8.2 s").
    expect(screen.getByText('8.2 s')).toBeDefined();
  });

  it('renders empty-state copy when there are no operators', async () => {
    adminMock.getOperatorStats.mockResolvedValue({ since: '', rows: [] });
    adminMock.getOperatorLatency.mockResolvedValue({ since: '', rows: [] });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/No operator activity in the last 24 hours/i)).toBeDefined();
    });
  });
});
