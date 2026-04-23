// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { SupplierMarginCard, formatBps, formatMinor } from '../SupplierMarginCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getSupplierMargin: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getSupplierMargin: () => adminMock.getSupplierMargin(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <SupplierMarginCard />
    </QueryClientProvider>,
  );
  return container;
}

describe('formatBps', () => {
  it('converts bps to two-decimal percent', () => {
    expect(formatBps(0)).toBe('0.00%');
    expect(formatBps(250)).toBe('2.50%');
    expect(formatBps(10_000)).toBe('100.00%');
  });
});

describe('formatMinor', () => {
  it('renders minor-units bigint strings as localised currency', () => {
    expect(formatMinor('12500', 'USD')).toBe('$125');
    expect(formatMinor('0', 'GBP')).toBe('£0');
  });

  it('returns em-dash on malformed input', () => {
    expect(formatMinor('not-a-number', 'USD')).toBe('—');
  });
});

describe('<SupplierMarginCard />', () => {
  it('shows fleet-wide margin headline when the ledger has activity', async () => {
    adminMock.getSupplierMargin.mockResolvedValue({
      rows: [
        {
          currency: null,
          chargeMinor: '1000000',
          wholesaleMinor: '800000',
          userCashbackMinor: '150000',
          loopMarginMinor: '50000',
          orderCount: 420,
          marginBps: 500,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Supplier margin')).toBeDefined();
    });
    expect(screen.getByText('5.00%')).toBeDefined();
    expect(screen.getByText(/420 fulfilled orders/)).toBeDefined();
    // Single-currency deployment — no per-currency table.
    expect(screen.queryByText('Rate')).toBeNull();
  });

  it('renders per-currency breakdown when >1 currency has activity', async () => {
    adminMock.getSupplierMargin.mockResolvedValue({
      rows: [
        {
          currency: null,
          chargeMinor: '1000000',
          wholesaleMinor: '800000',
          userCashbackMinor: '150000',
          loopMarginMinor: '50000',
          orderCount: 420,
          marginBps: 500,
        },
        {
          currency: 'USD',
          chargeMinor: '700000',
          wholesaleMinor: '560000',
          userCashbackMinor: '105000',
          loopMarginMinor: '35000',
          orderCount: 300,
          marginBps: 500,
        },
        {
          currency: 'GBP',
          chargeMinor: '300000',
          wholesaleMinor: '240000',
          userCashbackMinor: '45000',
          loopMarginMinor: '15000',
          orderCount: 120,
          marginBps: 500,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Rate')).toBeDefined();
    });
    expect(screen.getByText('USD')).toBeDefined();
    expect(screen.getByText('GBP')).toBeDefined();
  });

  it('shows muted zero-state when no fulfilled orders have landed', async () => {
    adminMock.getSupplierMargin.mockResolvedValue({
      rows: [
        {
          currency: null,
          chargeMinor: '0',
          wholesaleMinor: '0',
          userCashbackMinor: '0',
          loopMarginMinor: '0',
          orderCount: 0,
          marginBps: 0,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders yet/i)).toBeDefined();
    });
    expect(screen.getByText('0.00%')).toBeDefined();
  });

  it('self-hides when no fleet-wide row is present', async () => {
    adminMock.getSupplierMargin.mockResolvedValue({ rows: [] });
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getSupplierMargin).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('self-hides on error', async () => {
    adminMock.getSupplierMargin.mockRejectedValue(new Error('boom'));
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getSupplierMargin).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
