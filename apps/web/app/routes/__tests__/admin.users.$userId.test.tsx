// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { AdminUserWalletResponse } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import AdminUserDetailRoute from '../admin.users.$userId';

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any
// import pulls the store in (vi.hoisted runs pre-import).
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

/**
 * ADR 037 role-gating coverage for the User 360 page: support sees
 * the reads + the wallet card (with its support-allowed re-trigger),
 * while the money-write forms and the CSV export render only for
 * the admin role — hidden, not disabled.
 */
const { adminMock, authMock, userMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUser: vi.fn(),
    getAdminUserCredits: vi.fn(),
    getAdminUserWallet: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
  userMock: {
    staffRole: 'admin' as 'admin' | 'support' | null,
    isAdmin: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  const empty = (value: unknown): (() => Promise<unknown>) => vi.fn(async () => value);
  return {
    ...actual,
    getAdminUser: (id: string) => adminMock.getAdminUser(id),
    getAdminUserCredits: (id: string) => adminMock.getAdminUserCredits(id),
    getAdminUserWallet: (id: string) => adminMock.getAdminUserWallet(id),
    // The 360 page mounts a dozen read cards — stub their fetchers
    // with benign empties so this test focuses on role gating.
    getTreasurySnapshot: empty({
      outstanding: {},
      totals: {},
      liabilities: {},
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: {},
      operatorPool: { size: 0, operators: [] },
    }),
    getAdminUserCashbackSummary: empty({
      userId: 'u-360',
      currency: 'GBP',
      lifetimeMinor: '0',
      thisMonthMinor: '0',
    }),
    getAdminUserFlywheelStats: empty({
      userId: 'u-360',
      currency: 'GBP',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 0,
      totalFulfilledChargeMinor: '0',
    }),
    listAdminOrders: empty({ orders: [] }),
    listPayouts: empty({ payouts: [] }),
    getAdminUserPaymentMethodShare: empty({
      userId: 'u-360',
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: {
        xlm: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        loop_asset: { orderCount: 0, chargeMinor: '0' },
      },
    }),
    getUserOperatorMix: empty({
      userId: 'u-360',
      since: '2026-06-11T00:00:00.000Z',
      rows: [],
    }),
    getAdminUserCashbackMonthly: empty({ userId: 'u-360', entries: [] }),
    getAdminUserCashbackByMerchant: empty({
      userId: 'u-360',
      currency: 'GBP',
      since: '2026-01-01T00:00:00.000Z',
      rows: [],
    }),
    listAdminUserCreditTransactions: empty({ transactions: [] }),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'staff-1',
      email: 'staff@loop.test',
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

const targetUser = {
  id: 'u-360',
  email: 'customer@example.com',
  isAdmin: false,
  homeCurrency: 'GBP',
  stellarAddress: null,
  ctxUserId: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

const wallet: AdminUserWalletResponse = {
  userId: 'u-360',
  provider: 'privy',
  walletId: 'wal-1',
  walletAddress: 'GWALLET360',
  stellarAddress: null,
  provisioning: 'wallet_created',
  provisioningAttempts: 2,
  provisioningLastAttemptAt: '2026-06-11T00:00:00.000Z',
  onChain: {
    accountExists: false,
    balances: [],
    asOf: '2026-06-11T00:00:00.000Z',
  },
};

beforeEach(() => {
  adminMock.getAdminUser.mockReset().mockResolvedValue(targetUser);
  adminMock.getAdminUserCredits.mockReset().mockResolvedValue({ rows: [] });
  adminMock.getAdminUserWallet.mockReset().mockResolvedValue(wallet);
  authMock.isAuthenticated = true;
  userMock.staffRole = 'admin';
  userMock.isAdmin = true;
});

function renderAt(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/users/u-360']}>
        <Routes>
          <Route path="/admin/users/:userId" element={<AdminUserDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AdminUserDetailRoute /> — ADR 037 role gating', () => {
  it('admin sees the wallet card AND the money-write forms + CSV', async () => {
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('customer@example.com')).toBeDefined();
    });
    // Wallet card (both roles).
    await waitFor(() => {
      expect(screen.getByText(/wallet created — not activated/i)).toBeDefined();
    });
    // Admin-only surfaces (headings — the body copy repeats the
    // phrases, so text queries would be ambiguous).
    expect(screen.getByRole('heading', { name: /Apply adjustment/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Queue emission/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Change home currency/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Download CSV/i })).toBeDefined();
    // Global lookup search renders for staff.
    expect(screen.getByRole('search', { name: /Global admin lookup/i })).toBeDefined();
  });

  it('support sees the reads + wallet card but NOT the money forms or CSV', async () => {
    userMock.staffRole = 'support';
    userMock.isAdmin = false;
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('customer@example.com')).toBeDefined();
    });
    // Wallet card + its support-allowed re-trigger action render.
    await waitFor(() => {
      expect(screen.getByText(/wallet created — not activated/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Re-trigger provisioning/i })).toBeDefined();
    // Money writes + CSV are hidden (not disabled) for support.
    expect(screen.queryByRole('heading', { name: /Apply adjustment/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Queue emission/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Change home currency/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download CSV/i })).toBeNull();
    // Ledger browser (read) still renders.
    expect(screen.getByRole('heading', { name: /Credit transactions/i })).toBeDefined();
  });

  it('denies non-staff users at the shell gate', async () => {
    userMock.staffRole = null;
    userMock.isAdmin = false;
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Staff access required/i);
    });
    expect(adminMock.getAdminUser).not.toHaveBeenCalled();
  });
});
