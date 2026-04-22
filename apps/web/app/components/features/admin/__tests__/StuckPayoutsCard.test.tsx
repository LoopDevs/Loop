// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { StuckPayoutRow } from '~/services/admin';
import { StuckPayoutsCard, maxAgeMinutes } from '../StuckPayoutsCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getStuckPayouts: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getStuckPayouts: () => adminMock.getStuckPayouts(),
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
        <StuckPayoutsCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(ageMinutes: number, state = 'submitted'): StuckPayoutRow {
  return {
    id: `${ageMinutes}-${state}`,
    userId: 'u',
    orderId: 'o',
    assetCode: 'GBPLOOP',
    amountStroops: '1',
    state,
    stuckSince: new Date().toISOString(),
    ageMinutes,
    attempts: 1,
  };
}

describe('maxAgeMinutes (StuckPayoutsCard)', () => {
  it('returns 0 for an empty list', () => {
    expect(maxAgeMinutes([])).toBe(0);
  });

  it('returns the largest ageMinutes across rows', () => {
    expect(maxAgeMinutes([row(5), row(90), row(30)])).toBe(90);
  });
});

describe('<StuckPayoutsCard />', () => {
  it('renders zero with within-SLO copy when nothing is stuck', async () => {
    adminMock.getStuckPayouts.mockResolvedValue({ thresholdMinutes: 5, rows: [] });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Stuck payouts')).toBeDefined();
    });
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText(/all within SLO/)).toBeDefined();
  });

  it('renders count + oldest age when rows are present', async () => {
    adminMock.getStuckPayouts.mockResolvedValue({
      thresholdMinutes: 5,
      rows: [row(8), row(22), row(15)],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('3')).toBeDefined();
    });
    expect(screen.getByText(/oldest 22 min/)).toBeDefined();
  });

  it('surfaces em-dash on fetch error', async () => {
    adminMock.getStuckPayouts.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('—')).toBeDefined();
    });
  });
});
