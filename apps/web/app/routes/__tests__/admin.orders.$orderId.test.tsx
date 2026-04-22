// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import AdminOrderDetailRoute, { fmtMinor } from '../admin.orders.$orderId';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminOrder: vi.fn(),
    getAdminPayoutByOrder: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminOrder: (id: string) => adminMock.getAdminOrder(id),
    getAdminPayoutByOrder: (id: string) => adminMock.getAdminPayoutByOrder(id),
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

function renderAt(path = '/admin/orders/bbbb2222'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/orders/:orderId" element={<AdminOrderDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseRow = {
  id: 'bbbb2222',
  userId: '11111111-1111-1111-1111-111111111111',
  merchantId: 'mer-123',
  state: 'fulfilled' as const,
  currency: 'GBP',
  faceValueMinor: '10000',
  chargeCurrency: 'GBP',
  chargeMinor: '10000',
  paymentMethod: 'credit' as const,
  wholesalePct: '80.00',
  userCashbackPct: '10.00',
  loopMarginPct: '10.00',
  wholesaleMinor: '8000',
  userCashbackMinor: '1000',
  loopMarginMinor: '1000',
  ctxOrderId: 'ctx-xyz',
  ctxOperatorId: 'operator-primary',
  failureReason: null,
  createdAt: '2026-04-20T10:00:00.000Z',
  paidAt: '2026-04-20T10:01:00.000Z',
  procuredAt: '2026-04-20T10:02:00.000Z',
  fulfilledAt: '2026-04-20T10:03:00.000Z',
  failedAt: null,
};

describe('fmtMinor', () => {
  it('renders GBP minor as localised currency', () => {
    expect(fmtMinor('10000', 'GBP')).toMatch(/100\.00/);
  });

  it('returns em-dash for bad input', () => {
    expect(fmtMinor('not-a-number', 'GBP')).toBe('—');
  });
});

describe('<AdminOrderDetailRoute />', () => {
  it('renders the split + timeline for a fulfilled order', async () => {
    adminMock.getAdminOrder.mockResolvedValue(baseRow);
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('bbbb2222')).toBeDefined();
    });
    expect(screen.getByText(/fulfilled/)).toBeDefined();
    // Cashback split percentages render.
    expect(screen.getAllByText(/80\.00%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/10\.00%/).length).toBeGreaterThan(0);
  });

  it('renders the failure-reason section on failed orders', async () => {
    adminMock.getAdminOrder.mockResolvedValue({
      ...baseRow,
      state: 'failed',
      failureReason: 'CTX operator rejected: insufficient supply',
      fulfilledAt: null,
      failedAt: '2026-04-20T10:04:00.000Z',
    });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failure reason/)).toBeDefined();
    });
    expect(screen.getByText(/insufficient supply/)).toBeDefined();
  });

  it('renders a 404 body when the order is not found', async () => {
    adminMock.getAdminOrder.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Order not found/)).toBeDefined();
    });
  });

  it('renders a generic error banner on non-404 fetch error', async () => {
    adminMock.getAdminOrder.mockRejectedValue(new Error('boom'));
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load order/)).toBeDefined();
    });
  });

  it('renders a payout card when an on-chain payout exists for the order', async () => {
    adminMock.getAdminOrder.mockResolvedValue(baseRow);
    adminMock.getAdminPayoutByOrder.mockResolvedValue({
      id: 'payout-9999',
      userId: baseRow.userId,
      orderId: baseRow.id,
      assetCode: 'GBPLOOP',
      assetIssuer: 'GISSUER',
      toAddress: 'GDEST',
      amountStroops: '10000000',
      memoText: 'memo',
      state: 'confirmed',
      txHash: 'tx',
      lastError: null,
      attempts: 1,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: '2026-04-20T10:01:00.000Z',
      confirmedAt: '2026-04-20T10:02:00.000Z',
      failedAt: null,
    });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/On-chain payout/)).toBeDefined();
    });
    const fullLink = screen.getByRole('link', { name: /See full payout/ });
    expect(fullLink.getAttribute('href')).toBe('/admin/payouts/payout-9999');
    expect(screen.getByText(/GBPLOOP/)).toBeDefined();
  });

  it('renders the "no payout yet" body when the endpoint 404s', async () => {
    adminMock.getAdminOrder.mockResolvedValue(baseRow);
    adminMock.getAdminPayoutByOrder.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/No payout row for this order yet/)).toBeDefined();
    });
  });
});
