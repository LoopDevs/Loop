// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import AdminPayoutDetailRoute, { fmtStroops } from '../admin.payouts.$id';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminPayout: vi.fn(),
    retryPayout: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminPayout: (id: string) => adminMock.getAdminPayout(id),
    retryPayout: (args: unknown) => adminMock.retryPayout(args),
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

function renderAt(path = '/admin/payouts/aaaa1111'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/payouts/:id" element={<AdminPayoutDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseRow = {
  id: 'aaaa1111',
  userId: '11111111-1111-1111-1111-111111111111',
  orderId: 'bbbb2222',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GDESTINATION',
  amountStroops: '12500000',
  memoText: 'order-bbbb2222',
  state: 'confirmed' as const,
  txHash: 'abcdef0123456789',
  lastError: null,
  attempts: 1,
  createdAt: '2026-04-20T10:00:00.000Z',
  submittedAt: '2026-04-20T10:01:00.000Z',
  confirmedAt: '2026-04-20T10:02:00.000Z',
  failedAt: null,
};

describe('fmtStroops', () => {
  it('trims trailing zeros', () => {
    expect(fmtStroops('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('handles whole-number amounts', () => {
    expect(fmtStroops('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtStroops('garbage', 'GBPLOOP')).toBe('—');
  });
});

describe('<AdminPayoutDetailRoute />', () => {
  it('renders the row with a Stellar Expert link for confirmed payouts', async () => {
    adminMock.getAdminPayout.mockResolvedValue(baseRow);
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('1.25 GBPLOOP')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /View on Stellar Expert/ });
    expect(link.getAttribute('href')).toMatch(/stellar\.expert/);
  });

  it('shows the retry button only on failed rows', async () => {
    adminMock.getAdminPayout.mockResolvedValue({
      ...baseRow,
      state: 'failed',
      failedAt: '2026-04-20T10:03:00.000Z',
      lastError: 'op_underfunded',
      txHash: null,
      confirmedAt: null,
    });
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry payout/ })).toBeDefined();
    });
    expect(screen.getByText(/op_underfunded/)).toBeDefined();
  });

  it('renders a 404 body when the payout is not found', async () => {
    adminMock.getAdminPayout.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Payout not found/)).toBeDefined();
    });
  });

  it('renders a generic error when the fetch fails with non-404', async () => {
    adminMock.getAdminPayout.mockRejectedValue(new Error('boom'));
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payout/)).toBeDefined();
    });
  });
});
