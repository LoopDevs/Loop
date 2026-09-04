// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import AdminOrderDetailRoute, { fmtMinor } from '../admin.orders.$orderId';

afterEach(cleanup);

// The route mounts OrderDeliveryPanel (ADR 037), which reads the
// ui.store for toasts — the store resolves the initial theme via
// window.matchMedia at import time, which jsdom doesn't implement.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

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
  chargeMinor: '9000',
  userCashbackMinor: '1000',
  expectedCommissionMinor: '500',
  ctxOrderId: 'ctx-xyz',
  ctxPaymentId: 'ctxpay-123',
  paymentCryptoCurrency: 'XLM',
  failureReason: null,
  createdAt: '2026-04-20T10:00:00.000Z',
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
  it('renders the economics + timeline for a fulfilled order', async () => {
    adminMock.getAdminOrder.mockResolvedValue(baseRow);
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('bbbb2222')).toBeDefined();
    });
    // 'fulfilled' also appears in the ADR 037 delivery panel copy —
    // assert the state pill specifically.
    expect(
      screen.getAllByText(/fulfilled/).some((el) => el.className.includes('rounded-full')),
    ).toBe(true);
    // ADR 052 economics: cashback discount + expected CTX commission.
    expect(screen.getByText(/Cashback discount/)).toBeDefined();
    expect(screen.getAllByText(/£10\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Expected commission/)).toBeDefined();
    expect(screen.getAllByText(/£5\.00/).length).toBeGreaterThan(0);
    // CTX linkage renders.
    expect(screen.getByText('ctx-xyz')).toBeDefined();
    expect(screen.getByText('ctxpay-123')).toBeDefined();
  });

  it('renders the failure-reason section on rejected orders', async () => {
    adminMock.getAdminOrder.mockResolvedValue({
      ...baseRow,
      state: 'rejected',
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

  it('renders the payment-currency pill (ADR 052) and omits it on legacy rows', async () => {
    adminMock.getAdminOrder.mockResolvedValue(baseRow);
    adminMock.getAdminPayoutByOrder.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('XLM')).toBeDefined();
    });
  });

  it('omits the payment-currency pill on legacy rows (null cryptoCurrency)', async () => {
    adminMock.getAdminOrder.mockResolvedValue({
      ...baseRow,
      paymentCryptoCurrency: null,
    });
    adminMock.getAdminPayoutByOrder.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('bbbb2222')).toBeDefined();
    });
    expect(screen.queryByText('XLM')).toBeNull();
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
