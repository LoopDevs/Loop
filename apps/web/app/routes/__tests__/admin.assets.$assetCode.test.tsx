// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as AdminModule from '~/services/admin';
import AdminAssetDetailRoute from '../admin.assets.$assetCode';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getTreasurySnapshot: vi.fn(),
    getPayoutsByAsset: vi.fn(),
    getTopUsersByPendingPayout: vi.fn(),
    getPayoutsActivity: vi.fn(),
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTreasurySnapshot: () => adminMock.getTreasurySnapshot(),
    getPayoutsByAsset: () => adminMock.getPayoutsByAsset(),
    getTopUsersByPendingPayout: (opts?: unknown) => adminMock.getTopUsersByPendingPayout(opts),
    getPayoutsActivity: (days?: number) => adminMock.getPayoutsActivity(days),
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

function renderAt(path = '/admin/assets/USDLOOP'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/assets/:assetCode" element={<AdminAssetDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AdminAssetDetailRoute />', () => {
  it('shows a sign-in prompt when unauthenticated', () => {
    authMock.isAuthenticated = false;
    try {
      renderAt();
      expect(screen.getByText(/Sign in with an admin account/i)).toBeDefined();
    } finally {
      authMock.isAuthenticated = true;
    }
  });

  it('rejects an unknown asset code with a clear 400-style body', async () => {
    renderAt('/admin/assets/JPYLOOP');
    await waitFor(() => {
      expect(screen.getByText(/Unknown asset code/i)).toBeDefined();
    });
  });

  it('renders outstanding liability + Stellar Expert issuer link', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {
        USDLOOP: { outstandingMinor: '150000', issuer: 'GABCDEF1234567890' },
        GBPLOOP: { outstandingMinor: '0', issuer: null },
        EURLOOP: { outstandingMinor: '0', issuer: null },
      },
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: { pending: '0', submitted: '0', confirmed: '0', failed: '0' },
      operatorPool: { size: 0, operators: [] },
    });
    adminMock.getPayoutsByAsset.mockResolvedValue({ rows: [] });
    adminMock.getTopUsersByPendingPayout.mockResolvedValue({ entries: [] });
    adminMock.getPayoutsActivity.mockResolvedValue({ days: 30, rows: [] });

    renderAt();

    await waitFor(() => {
      expect(screen.getByText('$1,500.00')).toBeDefined();
    });

    const expertLink = screen.getByRole('link', { name: /View on Stellar Expert/i });
    expect(expertLink.getAttribute('href')).toBe(
      'https://stellar.expert/explorer/public/account/GABCDEF1234567890',
    );
  });

  it('renders payouts-by-state pills with deep-link filters scoped to this asset', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {
        USDLOOP: { outstandingMinor: '0', issuer: null },
        GBPLOOP: { outstandingMinor: '0', issuer: null },
        EURLOOP: { outstandingMinor: '0', issuer: null },
      },
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: { pending: '0', submitted: '0', confirmed: '0', failed: '0' },
      operatorPool: { size: 0, operators: [] },
    });
    adminMock.getPayoutsByAsset.mockResolvedValue({
      rows: [
        {
          assetCode: 'USDLOOP',
          pending: { count: 3, stroops: '10000000' },
          submitted: { count: 1, stroops: '5000000' },
          confirmed: { count: 42, stroops: '420000000' },
          failed: { count: 2, stroops: '8000000' },
        },
      ],
    });
    adminMock.getTopUsersByPendingPayout.mockResolvedValue({ entries: [] });
    adminMock.getPayoutsActivity.mockResolvedValue({ days: 30, rows: [] });

    renderAt();

    await waitFor(() => {
      const failedPill = screen.getByRole('link', { name: /failed/i });
      expect(failedPill.getAttribute('href')).toContain('assetCode=USDLOOP');
      expect(failedPill.getAttribute('href')).toContain('state=failed');
    });
  });

  it('renders only the top-holders entries matching this asset', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {
        USDLOOP: { outstandingMinor: '0', issuer: null },
        GBPLOOP: { outstandingMinor: '0', issuer: null },
        EURLOOP: { outstandingMinor: '0', issuer: null },
      },
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: { pending: '0', submitted: '0', confirmed: '0', failed: '0' },
      operatorPool: { size: 0, operators: [] },
    });
    adminMock.getPayoutsByAsset.mockResolvedValue({ rows: [] });
    adminMock.getTopUsersByPendingPayout.mockResolvedValue({
      entries: [
        {
          userId: 'u1',
          email: 'alice@example.com',
          assetCode: 'USDLOOP',
          totalStroops: '10000000',
          payoutCount: 2,
        },
        {
          userId: 'u2',
          email: 'bob@example.com',
          assetCode: 'GBPLOOP',
          totalStroops: '5000000',
          payoutCount: 1,
        },
      ],
    });
    adminMock.getPayoutsActivity.mockResolvedValue({ days: 30, rows: [] });

    renderAt();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeDefined();
    });
    expect(screen.queryByText('bob@example.com')).toBeNull();
  });
});
