// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { PaymentMethodShareCard, fmtPct, fmtPctBigint } from '../PaymentMethodShareCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getPaymentMethodShare: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getPaymentMethodShare: (opts?: { state?: string }) => adminMock.getPaymentMethodShare(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <PaymentMethodShareCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('fmtPct', () => {
  it('renders one-decimal integer share', () => {
    expect(fmtPct(390, 448)).toBe('87.1%');
  });

  it('returns em-dash for zero / negative denominator', () => {
    expect(fmtPct(5, 0)).toBe('—');
  });
});

describe('fmtPctBigint', () => {
  it('renders one-decimal share via bigint arithmetic', () => {
    expect(fmtPctBigint('500', 1000n)).toBe('50.0%');
    expect(fmtPctBigint('250', 1000n)).toBe('25.0%');
  });

  it('returns em-dash for zero total', () => {
    expect(fmtPctBigint('10', 0n)).toBe('—');
  });

  it('returns em-dash for malformed input', () => {
    expect(fmtPctBigint('nope', 100n)).toBe('—');
  });
});

describe('<PaymentMethodShareCard />', () => {
  it('shows the error state on fetch failure', async () => {
    adminMock.getPaymentMethodShare.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payment-method share/i)).toBeDefined();
    });
  });

  it('renders the empty state when no fulfilled orders yet', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 0,
      byMethod: {
        xlm: { orderCount: 0, chargeMinor: '0' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 0, chargeMinor: '0' },
        loop_asset: { orderCount: 0, chargeMinor: '0' },
      },
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders yet/i)).toBeDefined();
    });
  });

  it('renders one row per rail with counts + order / charge shares', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 448,
      byMethod: {
        xlm: { orderCount: 50, chargeMinor: '50000' },
        usdc: { orderCount: 0, chargeMinor: '0' },
        credit: { orderCount: 8, chargeMinor: '8000' },
        loop_asset: { orderCount: 390, chargeMinor: '390000' },
      },
    });
    renderCard();
    await screen.findByText(/LOOP asset/);
    // All four rails rendered with their labels.
    expect(screen.getByText(/LOOP asset/)).toBeDefined();
    expect(screen.getByText(/Credit balance/)).toBeDefined();
    expect(screen.getByText('USDC')).toBeDefined();
    expect(screen.getByText('XLM')).toBeDefined();
    // Order counts.
    expect(screen.getByText('390')).toBeDefined();
    expect(screen.getByText('50')).toBeDefined();
    expect(screen.getByText('8')).toBeDefined();
    // Share cells (loop_asset dominates as intended). Both the
    // orders-share and charge-share for loop_asset resolve to 87.1%
    // in this fixture (50 + 8 + 390 = 448, and charge minors have
    // the same ratio), so two cells match — that's expected.
    expect(screen.getAllByText('87.1%').length).toBeGreaterThanOrEqual(1);
    // xlm's 50/448 orders and 50000/448000 charge both read as 11.2%.
    expect(screen.getAllByText('11.2%').length).toBeGreaterThanOrEqual(1);
  });

  it('deep-links each rail to /admin/orders with paymentMethod + state=fulfilled', async () => {
    adminMock.getPaymentMethodShare.mockResolvedValue({
      state: 'fulfilled',
      totalOrders: 100,
      byMethod: {
        xlm: { orderCount: 10, chargeMinor: '1000' },
        usdc: { orderCount: 20, chargeMinor: '2000' },
        credit: { orderCount: 30, chargeMinor: '3000' },
        loop_asset: { orderCount: 40, chargeMinor: '4000' },
      },
    });
    renderCard();
    const loopLink = (await screen.findByText(/LOOP asset/)).closest('a');
    expect(loopLink?.getAttribute('href')).toBe(
      '/admin/orders?paymentMethod=loop_asset&state=fulfilled',
    );
    const xlmLink = screen.getByText('XLM').closest('a');
    expect(xlmLink?.getAttribute('href')).toBe('/admin/orders?paymentMethod=xlm&state=fulfilled');
  });
});
