// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { RealizationSparkline, toDailyBps } from '../RealizationSparkline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getCashbackRealizationDaily: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getCashbackRealizationDaily: () => adminMock.getCashbackRealizationDaily(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderSparkline(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <RealizationSparkline />
    </QueryClientProvider>,
  );
  return container;
}

describe('toDailyBps', () => {
  it('returns an empty array for empty input', () => {
    expect(toDailyBps([])).toEqual([]);
  });

  it('collapses per-(day, currency) rows into per-day fleet bps', () => {
    // 2026-04-15: USD 1000 earned / 250 spent + GBP 500 earned / 250 spent
    // Fleet: earned=1500, spent=500 → 500/1500 × 10_000 = 3333
    // 2026-04-16: USD 2000 earned / 1000 spent → 5000
    const rows = [
      {
        day: '2026-04-15',
        currency: 'USD',
        earnedMinor: '1000',
        spentMinor: '250',
        recycledBps: 2500,
      },
      {
        day: '2026-04-15',
        currency: 'GBP',
        earnedMinor: '500',
        spentMinor: '250',
        recycledBps: 5000,
      },
      {
        day: '2026-04-16',
        currency: 'USD',
        earnedMinor: '2000',
        spentMinor: '1000',
        recycledBps: 5000,
      },
    ];
    expect(toDailyBps(rows)).toEqual([3333, 5000]);
  });

  it('emits 0 for days where earned was zero', () => {
    const rows = [
      {
        day: '2026-04-15',
        currency: 'USD',
        earnedMinor: '0',
        spentMinor: '0',
        recycledBps: 0,
      },
      {
        day: '2026-04-16',
        currency: 'USD',
        earnedMinor: '100',
        spentMinor: '50',
        recycledBps: 5000,
      },
    ];
    expect(toDailyBps(rows)).toEqual([0, 5000]);
  });

  it('sorts days chronologically even when backend rows arrive out of order', () => {
    const rows = [
      {
        day: '2026-04-17',
        currency: 'USD',
        earnedMinor: '300',
        spentMinor: '100',
        recycledBps: 3333,
      },
      {
        day: '2026-04-15',
        currency: 'USD',
        earnedMinor: '100',
        spentMinor: '10',
        recycledBps: 1000,
      },
    ];
    const [first, second] = toDailyBps(rows);
    expect(first).toBe(1000); // 2026-04-15
    expect(second).toBe(3333); // 2026-04-17
  });

  it('clamps bps that would round above 10 000 (corrupt ledger defence)', () => {
    const rows = [
      {
        day: '2026-04-15',
        currency: 'USD',
        earnedMinor: '100',
        spentMinor: '300',
        recycledBps: 10_000,
      },
    ];
    expect(toDailyBps(rows)).toEqual([10_000]);
  });

  it('skips rows with malformed bigint strings rather than crashing', () => {
    const rows = [
      {
        day: '2026-04-15',
        currency: 'USD',
        earnedMinor: 'not-a-number',
        spentMinor: '100',
        recycledBps: 0,
      },
    ];
    expect(toDailyBps(rows)).toEqual([]);
  });
});

describe('<RealizationSparkline />', () => {
  it('renders the sparkline chrome with today label', async () => {
    adminMock.getCashbackRealizationDaily.mockResolvedValue({
      days: 30,
      rows: [
        {
          day: '2026-04-23',
          currency: 'USD',
          earnedMinor: '1000',
          spentMinor: '2500',
          recycledBps: 10_000,
        },
      ],
    });
    renderSparkline();
    await waitFor(() => {
      expect(screen.getByText(/Realization rate \(30d\)/)).toBeDefined();
    });
    // 10_000 bps → 100.0% today — clamped.
    expect(screen.getByText(/100.0% today/)).toBeDefined();
  });
});
