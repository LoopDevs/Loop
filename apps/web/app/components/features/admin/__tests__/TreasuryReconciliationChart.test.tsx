// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { TreasuryReconciliationChart, mergePerCurrency } from '../TreasuryReconciliationChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminCashbackMonthly: vi.fn(),
    getAdminPayoutsMonthly: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminCashbackMonthly: () => adminMock.getAdminCashbackMonthly(),
    getAdminPayoutsMonthly: () => adminMock.getAdminPayoutsMonthly(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TreasuryReconciliationChart />
    </QueryClientProvider>,
  );
}

describe('mergePerCurrency()', () => {
  it('pairs cashback (fiat minor) with payouts (stroops / 100000) into per-currency rows', () => {
    // 15000 pence minted in GBP. 10 * 1e5 = 1_000_000 stroops settled = 10 pence.
    const out = mergePerCurrency(
      [{ month: '2026-04', currency: 'GBP', cashbackMinor: '15000' }],
      [
        {
          month: '2026-04',
          assetCode: 'GBPLOOP',
          // 10000 pence worth of stroops = 10000 * 100000 = 1_000_000_000.
          paidStroops: '1000000000',
          payoutCount: 3,
        },
      ],
    );
    const gbp = out.get('GBP');
    expect(gbp).toBeDefined();
    expect(gbp).toHaveLength(1);
    const row = gbp![0]!;
    expect(row.month).toBe('2026-04');
    expect(row.mintedMinor).toBe(15000n);
    expect(row.settledMinor).toBe(10000n);
    expect(row.netMinor).toBe(5000n); // +50 pence liability growth.
  });

  it('maps asset codes back to their home currency (USDLOOP → USD, EURLOOP → EUR)', () => {
    const out = mergePerCurrency(
      [],
      [
        { month: '2026-04', assetCode: 'USDLOOP', paidStroops: '100000', payoutCount: 1 },
        { month: '2026-04', assetCode: 'EURLOOP', paidStroops: '200000', payoutCount: 1 },
      ],
    );
    expect(out.get('USD')?.[0]?.settledMinor).toBe(1n);
    expect(out.get('EUR')?.[0]?.settledMinor).toBe(2n);
  });

  it('handles cashback-only months (no payouts yet for that currency)', () => {
    const out = mergePerCurrency(
      [{ month: '2026-04', currency: 'GBP', cashbackMinor: '5000' }],
      [],
    );
    const row = out.get('GBP')?.[0];
    expect(row?.mintedMinor).toBe(5000n);
    expect(row?.settledMinor).toBe(0n);
    expect(row?.netMinor).toBe(5000n); // +£50 liability growth.
  });

  it('handles payout-only months (catch-up settlements, no minting that month)', () => {
    // 500_000 stroops = 5 pence settled, 0 minted.
    const out = mergePerCurrency(
      [],
      [{ month: '2026-04', assetCode: 'GBPLOOP', paidStroops: '500000', payoutCount: 1 }],
    );
    const row = out.get('GBP')?.[0];
    expect(row?.mintedMinor).toBe(0n);
    expect(row?.settledMinor).toBe(5n);
    expect(row?.netMinor).toBe(-5n); // liability shrank 5p.
  });

  it('sorts months ascending within a currency', () => {
    const out = mergePerCurrency(
      [
        { month: '2026-03', currency: 'GBP', cashbackMinor: '100' },
        { month: '2026-04', currency: 'GBP', cashbackMinor: '200' },
        { month: '2026-02', currency: 'GBP', cashbackMinor: '50' },
      ],
      [],
    );
    const months = out.get('GBP')?.map((r) => r.month);
    expect(months).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('skips unknown asset codes silently (forward-compatibility)', () => {
    // A future LOOP asset not yet in the union shouldn't crash the chart.
    const out = mergePerCurrency(
      [],
      [
        { month: '2026-04', assetCode: 'JPYLOOP', paidStroops: '999', payoutCount: 1 },
        { month: '2026-04', assetCode: 'GBPLOOP', paidStroops: '100000', payoutCount: 1 },
      ],
    );
    expect(out.size).toBe(1);
    expect(out.get('GBP')).toBeDefined();
    expect(out.has('JPY')).toBe(false);
  });
});

describe('<TreasuryReconciliationChart />', () => {
  it('renders the empty-state line when both series are empty', async () => {
    adminMock.getAdminCashbackMonthly.mockResolvedValue({ entries: [] });
    adminMock.getAdminPayoutsMonthly.mockResolvedValue({ entries: [] });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No cashback minted or payouts confirmed/i)).toBeDefined();
    });
  });

  it('renders per-currency rows with minted + settled + net labels', async () => {
    adminMock.getAdminCashbackMonthly.mockResolvedValue({
      entries: [
        { month: '2026-04', currency: 'GBP', cashbackMinor: '15000' }, // £150.00 minted
      ],
    });
    adminMock.getAdminPayoutsMonthly.mockResolvedValue({
      entries: [
        {
          month: '2026-04',
          assetCode: 'GBPLOOP',
          paidStroops: '1000000000', // 10000 pence settled = £100.00
          payoutCount: 3,
        },
      ],
    });
    renderChart();
    // Currency label, minted amount, settled amount, positive net.
    await waitFor(() => {
      expect(screen.getByText('GBP')).toBeDefined();
    });
    // formatMinor rounds to whole units (maximumFractionDigits: 0)
    // — matches the cashback-monthly chart convention.
    expect(screen.getByText('£150')).toBeDefined();
    expect(screen.getByText('£100')).toBeDefined();
    // Net = +£50 liability growth (positive sign, orange colour).
    expect(screen.getByText('+£50')).toBeDefined();
  });

  it('shows an inline error line on any query failure', async () => {
    adminMock.getAdminCashbackMonthly.mockResolvedValue({ entries: [] });
    adminMock.getAdminPayoutsMonthly.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load treasury reconciliation/i)).toBeDefined();
    });
  });
});
