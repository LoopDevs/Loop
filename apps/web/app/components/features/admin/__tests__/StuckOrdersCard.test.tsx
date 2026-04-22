// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { StuckOrderRow } from '~/services/admin';
import { StuckOrdersCard, maxAgeMinutes } from '../StuckOrdersCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getStuckOrders: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getStuckOrders: () => adminMock.getStuckOrders(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StuckOrdersCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(ageMinutes: number, state = 'paid'): StuckOrderRow {
  return {
    id: `${ageMinutes}-${state}`,
    userId: 'u',
    merchantId: 'm',
    state,
    stuckSince: new Date().toISOString(),
    ageMinutes,
    ctxOrderId: null,
    ctxOperatorId: null,
  };
}

describe('maxAgeMinutes', () => {
  it('returns 0 for an empty list', () => {
    expect(maxAgeMinutes([])).toBe(0);
  });

  it('returns the largest ageMinutes across rows', () => {
    expect(maxAgeMinutes([row(5), row(90), row(30)])).toBe(90);
  });

  it('handles a single row', () => {
    expect(maxAgeMinutes([row(12)])).toBe(12);
  });
});

describe('<StuckOrdersCard />', () => {
  it('renders zero with within-SLO copy when there are no stuck orders', async () => {
    adminMock.getStuckOrders.mockResolvedValue({ thresholdMinutes: 15, rows: [] });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('0')).toBeDefined();
    });
    expect(screen.getByText(/all within SLO/)).toBeDefined();
  });

  it('renders count + oldest age when rows are present', async () => {
    adminMock.getStuckOrders.mockResolvedValue({
      thresholdMinutes: 15,
      rows: [row(22), row(58)],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('2')).toBeDefined();
    });
    expect(screen.getByText(/oldest 58 min/)).toBeDefined();
  });

  it('surfaces em-dash on fetch error', async () => {
    adminMock.getStuckOrders.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('—')).toBeDefined();
    });
  });
});
