// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as AdminModule from '~/services/admin';
import AdminAssetsIndexRoute, { buildAssetSummaries } from '../admin.assets';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getTreasurySnapshot: vi.fn(),
    getPayoutsByAsset: vi.fn(),
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTreasurySnapshot: () => adminMock.getTreasurySnapshot(),
    getPayoutsByAsset: () => adminMock.getPayoutsByAsset(),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderAt(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/assets']}>
        <Routes>
          <Route path="/admin/assets" element={<AdminAssetsIndexRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('buildAssetSummaries', () => {
  it('emits one row per LOOP asset, zero-filled when missing', () => {
    const rows = buildAssetSummaries(undefined, undefined);
    expect(rows.map((r) => r.code)).toEqual(['USDLOOP', 'GBPLOOP', 'EURLOOP']);
    for (const r of rows) {
      expect(r.outstandingMinor).toBe('0');
      expect(r.issuer).toBeNull();
      expect(r.pending).toBe(0);
      expect(r.failed).toBe(0);
    }
  });

  it('joins liabilities + byAsset payout-state counts', () => {
    const rows = buildAssetSummaries(
      {
        USDLOOP: { outstandingMinor: '150000', issuer: 'GABC123' },
        GBPLOOP: { outstandingMinor: '0', issuer: null },
        EURLOOP: { outstandingMinor: '42000', issuer: 'GEURISSUER' },
      },
      [
        {
          assetCode: 'USDLOOP',
          pending: { count: 3, stroops: '0' },
          submitted: { count: 1, stroops: '0' },
          confirmed: { count: 42, stroops: '0' },
          failed: { count: 2, stroops: '0' },
        },
      ],
    );
    expect(rows[0]).toEqual({
      code: 'USDLOOP',
      fiat: 'USD',
      outstandingMinor: '150000',
      issuer: 'GABC123',
      pending: 3,
      submitted: 1,
      confirmed: 42,
      failed: 2,
    });
    expect(rows[2]!.issuer).toBe('GEURISSUER');
    expect(rows[2]!.failed).toBe(0); // no byAsset row → zero counts
  });
});

describe('<AdminAssetsIndexRoute />', () => {
  it('shows a sign-in prompt when unauthenticated', () => {
    authMock.isAuthenticated = false;
    try {
      renderAt();
      expect(screen.getByText(/Sign in with an admin account/i)).toBeDefined();
    } finally {
      authMock.isAuthenticated = true;
    }
  });

  it('renders one table row per asset with drill + failed-triage links', async () => {
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
    adminMock.getPayoutsByAsset.mockResolvedValue({
      rows: [
        {
          assetCode: 'USDLOOP',
          pending: { count: 3, stroops: '0' },
          submitted: { count: 0, stroops: '0' },
          confirmed: { count: 42, stroops: '0' },
          failed: { count: 2, stroops: '0' },
        },
      ],
    });
    renderAt();

    await waitFor(() => {
      expect(screen.getByText('USDLOOP')).toBeDefined();
    });
    expect(screen.getByText('GBPLOOP')).toBeDefined();
    expect(screen.getByText('EURLOOP')).toBeDefined();

    // Asset code links into the drill page.
    const drill = screen.getByRole('link', { name: /open usdloop asset detail/i });
    expect(drill.getAttribute('href')).toBe('/admin/assets/USDLOOP');

    // Failed-count cell on USDLOOP links into the incident-triage
    // filter scoped to the asset.
    const failed = screen.getByRole('link', { name: /review 2 failed usdloop payouts/i });
    expect(failed.getAttribute('href')).toBe('/admin/payouts?state=failed&assetCode=USDLOOP');

    // Outstanding gets the localised currency formatter.
    expect(screen.getByText('$1,500.00')).toBeDefined();

    // Not-configured issuer surfaces a pill, not a truncated pubkey.
    expect(screen.getAllByText(/not configured/i)).toHaveLength(2);
  });
});
