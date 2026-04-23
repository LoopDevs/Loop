// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { CreditFlowChart } from '../CreditFlowChart';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getTreasuryCreditFlow: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTreasuryCreditFlow: (opts?: { days?: number; currency?: 'USD' | 'GBP' | 'EUR' }) =>
      adminMock.getTreasuryCreditFlow(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChart(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreditFlowChart />
    </QueryClientProvider>,
  );
}

describe('<CreditFlowChart />', () => {
  it('renders the empty-state copy when every day is zero activity', async () => {
    adminMock.getTreasuryCreditFlow.mockResolvedValue({
      windowDays: 30,
      currency: 'USD',
      days: [
        {
          day: '2026-04-20',
          currency: 'USD',
          creditedMinor: '0',
          debitedMinor: '0',
          netMinor: '0',
        },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/No ledger activity for USD/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure', async () => {
    adminMock.getTreasuryCreditFlow.mockRejectedValue(new Error('boom'));
    renderChart();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load credit-flow activity/i)).toBeDefined();
    });
  });

  it('formats positive net with a + sign and aria label (liability growing)', async () => {
    adminMock.getTreasuryCreditFlow.mockResolvedValue({
      windowDays: 1,
      currency: 'USD',
      days: [
        {
          day: '2026-04-20',
          currency: 'USD',
          creditedMinor: '50000',
          debitedMinor: '12000',
          netMinor: '38000',
        },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Apr 20: credited \$500\.00, debited \$120\.00, net \+\$380\.00/i),
      ).toBeDefined();
    });
  });

  it('formats a negative net without a + sign (liability shrinking)', async () => {
    adminMock.getTreasuryCreditFlow.mockResolvedValue({
      windowDays: 1,
      currency: 'USD',
      days: [
        {
          day: '2026-04-20',
          currency: 'USD',
          creditedMinor: '100',
          debitedMinor: '400',
          netMinor: '-300',
        },
      ],
    });
    renderChart();
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Apr 20: credited \$1\.00, debited \$4\.00, net -\$3\.00/i),
      ).toBeDefined();
    });
  });

  it('switches currency via the tab picker and refetches', async () => {
    adminMock.getTreasuryCreditFlow.mockResolvedValue({
      windowDays: 30,
      currency: 'USD',
      days: [],
    });
    renderChart();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'USD' })).toHaveProperty('ariaSelected', 'true');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'EUR' }));
    await waitFor(() => {
      expect(
        adminMock.getTreasuryCreditFlow.mock.calls.some(
          (call) => (call[0] as { currency?: string } | undefined)?.currency === 'EUR',
        ),
      ).toBe(true);
    });
  });
});
