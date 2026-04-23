// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { CashbackRealizationCard, formatBps, formatMinor } from '../CashbackRealizationCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getCashbackRealization: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getCashbackRealization: () => adminMock.getCashbackRealization(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <CashbackRealizationCard />
    </QueryClientProvider>,
  );
  return container;
}

describe('formatBps', () => {
  it('converts basis points to two-decimal percent', () => {
    expect(formatBps(0)).toBe('0.00%');
    expect(formatBps(2500)).toBe('25.00%');
    expect(formatBps(10000)).toBe('100.00%');
    expect(formatBps(1234)).toBe('12.34%');
  });
});

describe('formatMinor', () => {
  it('renders minor-units bigint strings as localised currency', () => {
    expect(formatMinor('12500', 'USD')).toBe('$125');
    expect(formatMinor('0', 'GBP')).toBe('£0');
  });

  it('returns em-dash for malformed input rather than crashing', () => {
    expect(formatMinor('not-a-number', 'USD')).toBe('—');
  });
});

describe('<CashbackRealizationCard />', () => {
  it('shows the fleet-wide recycled percentage headline', async () => {
    adminMock.getCashbackRealization.mockResolvedValue({
      rows: [
        {
          currency: null,
          earnedMinor: '300000',
          spentMinor: '75000',
          withdrawnMinor: '5000',
          outstandingMinor: '220000',
          recycledBps: 2500,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Cashback realization')).toBeDefined();
    });
    expect(screen.getByText('25.00%')).toBeDefined();
    // Single-currency deployment (only the fleet row) — no per-currency table.
    expect(screen.queryByText(/Earned/)).toBeNull();
  });

  it('renders the per-currency breakdown when >1 currency has activity', async () => {
    adminMock.getCashbackRealization.mockResolvedValue({
      rows: [
        {
          currency: null,
          earnedMinor: '300000',
          spentMinor: '75000',
          withdrawnMinor: '0',
          outstandingMinor: '225000',
          recycledBps: 2500,
        },
        {
          currency: 'USD',
          earnedMinor: '200000',
          spentMinor: '50000',
          withdrawnMinor: '0',
          outstandingMinor: '150000',
          recycledBps: 2500,
        },
        {
          currency: 'GBP',
          earnedMinor: '100000',
          spentMinor: '25000',
          withdrawnMinor: '0',
          outstandingMinor: '75000',
          recycledBps: 2500,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      // Fleet row + two per-currency rows all show 25.00% in this fixture.
      expect(screen.getAllByText('25.00%').length).toBe(3);
    });
    expect(screen.getByText('USD')).toBeDefined();
    expect(screen.getByText('GBP')).toBeDefined();
    expect(screen.getByText('Earned')).toBeDefined();
  });

  it('renders a muted zero-state when no cashback has been emitted', async () => {
    adminMock.getCashbackRealization.mockResolvedValue({
      rows: [
        {
          currency: null,
          earnedMinor: '0',
          spentMinor: '0',
          withdrawnMinor: '0',
          outstandingMinor: '0',
          recycledBps: 0,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No cashback emitted yet/i)).toBeDefined();
    });
    expect(screen.getByText('0.00%')).toBeDefined();
  });

  it('self-hides when the response has no fleet-wide row', async () => {
    adminMock.getCashbackRealization.mockResolvedValue({ rows: [] });
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getCashbackRealization).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('self-hides on error (other operator-health cards cover the page)', async () => {
    adminMock.getCashbackRealization.mockRejectedValue(new Error('boom'));
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getCashbackRealization).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
