// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PublicStatsModule from '~/services/public-stats';
import { CashbackStatsBand, fmtPerCurrency, pickHeadlineCurrency } from '../CashbackStatsBand';

afterEach(cleanup);

const { publicStatsMock } = vi.hoisted(() => ({
  publicStatsMock: {
    getPublicCashbackStats: vi.fn(),
  },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStatsModule;
  return {
    ...actual,
    getPublicCashbackStats: () => publicStatsMock.getPublicCashbackStats(),
  };
});

function renderBand(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CashbackStatsBand />
    </QueryClientProvider>,
  );
}

describe('fmtPerCurrency', () => {
  it('renders GBP minor as localized, whole-unit currency', () => {
    expect(fmtPerCurrency({ currency: 'GBP', amountMinor: '420000' })).toMatch(/4,200/);
  });

  it('returns em-dash for non-finite amounts', () => {
    expect(fmtPerCurrency({ currency: 'GBP', amountMinor: 'not-a-number' })).toBe('—');
  });
});

describe('pickHeadlineCurrency', () => {
  it('returns undefined for an empty list', () => {
    expect(pickHeadlineCurrency([])).toBeUndefined();
  });

  it('picks the largest bigint amount across rows', () => {
    const picked = pickHeadlineCurrency([
      { currency: 'USD', amountMinor: '500' },
      { currency: 'GBP', amountMinor: '999999999999' },
      { currency: 'EUR', amountMinor: '1000' },
    ]);
    expect(picked?.currency).toBe('GBP');
  });

  it('skips rows whose amountMinor is not a valid bigint', () => {
    const picked = pickHeadlineCurrency([
      { currency: 'USD', amountMinor: 'garbage' },
      { currency: 'GBP', amountMinor: '50' },
    ]);
    expect(picked?.currency).toBe('GBP');
  });
});

describe('<CashbackStatsBand />', () => {
  it('hides itself while the first fetch is in flight', () => {
    publicStatsMock.getPublicCashbackStats.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CashbackStatsBand />
      </QueryClientProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides when the snapshot is still all zeros', async () => {
    publicStatsMock.getPublicCashbackStats.mockResolvedValue({
      totalUsersWithCashback: 0,
      totalCashbackByCurrency: [],
      fulfilledOrders: 0,
      asOf: new Date().toISOString(),
    });
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CashbackStatsBand />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(publicStatsMock.getPublicCashbackStats).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders three tiles with the localized headline amount', async () => {
    publicStatsMock.getPublicCashbackStats.mockResolvedValue({
      totalUsersWithCashback: 1234,
      totalCashbackByCurrency: [
        { currency: 'GBP', amountMinor: '420000' },
        { currency: 'USD', amountMinor: '1000' },
      ],
      fulfilledOrders: 5678,
      asOf: new Date().toISOString(),
    });
    renderBand();
    await waitFor(() => {
      expect(screen.getByText('1,234')).toBeDefined();
    });
    expect(screen.getByText('5,678')).toBeDefined();
    expect(screen.getByText(/4,200/)).toBeDefined();
  });
});
