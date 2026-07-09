// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { StuckOrderRow, StuckPayoutRow } from '~/services/admin';
import AdminStuckOrdersRoute, { ageClass } from '../admin.stuck-orders';

afterEach(cleanup);

const { adminMock, authMock, userMock } = vi.hoisted(() => ({
  adminMock: {
    getStuckOrders: vi.fn(),
    getStuckPayouts: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
  userMock: {
    staffRole: 'support' as 'admin' | 'support' | null,
    isAdmin: false,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getStuckOrders: () => adminMock.getStuckOrders(),
    getStuckPayouts: () => adminMock.getStuckPayouts(),
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

// A5-6: the page gates on `RequireStaff minimum="support"` (see
// admin.stuck-orders.tsx) — `getMe` is driven by a mutable `userMock`
// (default `staffRole: 'support'`, `isAdmin: false`) so the suite's
// baseline proves the SUPPORT path renders, not just the admin path.
// Same pattern as admin.skips.test.tsx (the other support-tier page).
import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'u1',
      email: 'support@loop.test',
      isAdmin: userMock.isAdmin,
      staffRole: userMock.staffRole,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

beforeEach(() => {
  userMock.staffRole = 'support';
  userMock.isAdmin = false;
});

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
    paymentMethod: overrides.paymentMethod ?? 'xlm',
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

function payoutRow(overrides: Partial<StuckPayoutRow> = {}): StuckPayoutRow {
  return {
    id: overrides.id ?? 'pppppppp1111222233334444',
    userId: overrides.userId ?? 'uuuuuuuu1111222233334444',
    orderId: overrides.orderId ?? 'oooooooo1111222233334444',
    assetCode: overrides.assetCode ?? 'GBPLOOP',
    amountStroops: overrides.amountStroops ?? '50000000',
    state: overrides.state ?? 'submitted',
    stuckSince: overrides.stuckSince ?? new Date().toISOString(),
    ageMinutes: overrides.ageMinutes ?? 12,
    attempts: overrides.attempts ?? 1,
  };
}

describe('<AdminStuckOrdersRoute />', () => {
  it('renders an all-clear card when no stuck rows', async () => {
    adminMock.getStuckOrders.mockResolvedValue({ thresholdMinutes: 15, rows: [] });
    adminMock.getStuckPayouts.mockResolvedValue({ thresholdMinutes: 5, rows: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/inside the 15-minute SLO/i)).toBeDefined();
    });
    // Stuck-payouts all-clear renders its own copy with its own threshold.
    expect(screen.getByText(/inside the 5-minute SLO/i)).toBeDefined();
  });

  it('renders a table row with a deep link when rows are present', async () => {
    adminMock.getStuckOrders.mockResolvedValue({
      thresholdMinutes: 15,
      rows: [row({ id: 'abcd1234efgh5678', userId: '9999aaaabbbbcccc', ageMinutes: 22 })],
    });
    adminMock.getStuckPayouts.mockResolvedValue({ thresholdMinutes: 5, rows: [] });
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
    adminMock.getStuckPayouts.mockResolvedValue({ thresholdMinutes: 5, rows: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load stuck orders/)).toBeDefined();
    });
  });

  it('renders stuck-payout rows with drill-through links', async () => {
    adminMock.getStuckOrders.mockResolvedValue({ thresholdMinutes: 15, rows: [] });
    adminMock.getStuckPayouts.mockResolvedValue({
      thresholdMinutes: 5,
      rows: [
        payoutRow({
          id: 'payoutid1234567890abcdef',
          orderId: 'orderid12345678',
          userId: 'userid123456789',
          assetCode: 'USDLOOP',
          amountStroops: '123450000',
          state: 'submitted',
          ageMinutes: 11,
        }),
      ],
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('payoutid')).toBeDefined();
    });
    const payoutLink = screen.getByRole('link', { name: /payoutid/ });
    expect(payoutLink.getAttribute('href')).toBe('/admin/payouts/payoutid1234567890abcdef');
    // Asset column links through to the per-asset filtered list.
    const assetLink = screen.getByRole('link', { name: 'USDLOOP' });
    expect(assetLink.getAttribute('href')).toBe('/admin/payouts?assetCode=USDLOOP');
    // Formatted stroops appear on the row.
    expect(screen.getByText(/12\.345 USDLOOP/)).toBeDefined();
    expect(screen.getByText('11m')).toBeDefined();
  });

  // A5-6: the concrete regression this whole change guards against —
  // a support-tier signed-in user must reach the triage table, not a
  // deny banner (the previous `<RequireAdmin>` wrapper 403'd here even
  // though the backend already served support 200s).
  it('a support-role user sees the triage table, not a deny banner (A5-6)', async () => {
    userMock.staffRole = 'support';
    userMock.isAdmin = false;
    adminMock.getStuckOrders.mockResolvedValue({
      thresholdMinutes: 15,
      rows: [row({ id: 'supportvis1234', ageMinutes: 30 })],
    });
    adminMock.getStuckPayouts.mockResolvedValue({ thresholdMinutes: 5, rows: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('supportv')).toBeDefined();
    });
    expect(screen.queryByText(/Staff access required/i)).toBeNull();
    expect(screen.queryByText(/Admin access required/i)).toBeNull();
  });

  it('denies a non-staff signed-in user at the shell gate', async () => {
    userMock.staffRole = null;
    userMock.isAdmin = false;
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Staff access required/i);
    });
    // The deny banner renders in place of the triage content — no
    // table, no all-clear card, from either query's data.
    expect(screen.queryByRole('table')).toBeNull();
  });
});
