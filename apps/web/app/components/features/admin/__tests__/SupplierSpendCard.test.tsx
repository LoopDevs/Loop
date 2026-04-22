// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { SupplierSpendCard, fmtMinor } from '../SupplierSpendCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getSupplierSpend: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getSupplierSpend: (opts: unknown) => adminMock.getSupplierSpend(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SupplierSpendCard />
    </QueryClientProvider>,
  );
}

describe('fmtMinor', () => {
  it('renders GBP minor as localized currency', () => {
    expect(fmtMinor('12500', 'GBP')).toMatch(/125\.00/);
  });

  it('returns em-dash for bad input', () => {
    expect(fmtMinor('abc', 'GBP')).toBe('—');
  });
});

describe('<SupplierSpendCard />', () => {
  it('renders per-currency rows with split columns', async () => {
    adminMock.getSupplierSpend.mockResolvedValue({
      since: new Date().toISOString(),
      rows: [
        {
          currency: 'GBP',
          count: 42,
          faceValueMinor: '420000',
          wholesaleMinor: '336000',
          userCashbackMinor: '42000',
          loopMarginMinor: '42000',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('GBP')).toBeDefined();
    });
    expect(screen.getByText('42')).toBeDefined();
    // Wholesale and face-value rendered via fmtMinor.
    expect(screen.getAllByText(/\d+\.00/).length).toBeGreaterThan(0);
  });

  it('renders an empty-state when no fulfilled orders in window', async () => {
    adminMock.getSupplierSpend.mockResolvedValue({
      since: new Date().toISOString(),
      rows: [],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No fulfilled orders in the last 24 hours/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.getSupplierSpend.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load supplier spend/)).toBeDefined();
    });
  });
});
