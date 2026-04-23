// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { SettlementLagCard, formatSeconds } from '../SettlementLagCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getSettlementLag: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getSettlementLag: () => adminMock.getSettlementLag(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <SettlementLagCard />
    </QueryClientProvider>,
  );
  return container;
}

describe('formatSeconds', () => {
  it('formats seconds / minutes / hours at the right boundaries', () => {
    expect(formatSeconds(45.3)).toBe('45s');
    expect(formatSeconds(59)).toBe('59s');
    expect(formatSeconds(60)).toBe('1.0m');
    expect(formatSeconds(150)).toBe('2.5m');
    expect(formatSeconds(3599)).toBe('60.0m');
    expect(formatSeconds(3600)).toBe('1.0h');
    expect(formatSeconds(4500)).toBe('1.3h');
  });
});

describe('<SettlementLagCard />', () => {
  it('renders fleet p50/p95/max + per-asset rows', async () => {
    adminMock.getSettlementLag.mockResolvedValue({
      since: '2026-04-22T00:00:00Z',
      rows: [
        {
          assetCode: null,
          sampleCount: 180,
          p50Seconds: 45,
          p95Seconds: 240,
          maxSeconds: 1200,
          meanSeconds: 80,
        },
        {
          assetCode: 'USDLOOP',
          sampleCount: 120,
          p50Seconds: 44,
          p95Seconds: 220,
          maxSeconds: 800,
          meanSeconds: 70,
        },
        {
          assetCode: 'GBPLOOP',
          sampleCount: 60,
          p50Seconds: 50,
          p95Seconds: 260,
          maxSeconds: 1200,
          meanSeconds: 100,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Settlement lag')).toBeDefined();
    });
    // Fleet-wide headline.
    expect(screen.getByText('45s')).toBeDefined(); // p50
    expect(screen.getByText('4.0m')).toBeDefined(); // p95 = 240s → 4.0m
    expect(screen.getByText('20.0m')).toBeDefined(); // max = 1200s → 20.0m
    // Per-asset table codes.
    expect(screen.getByText('USDLOOP')).toBeDefined();
    expect(screen.getByText('GBPLOOP')).toBeDefined();
    // Sample-count header in the top-right.
    expect(screen.getByText(/n=180/)).toBeDefined();
  });

  it('self-hides when the response has no rows (zero-payout deployment)', async () => {
    adminMock.getSettlementLag.mockResolvedValue({
      since: '2026-04-22T00:00:00Z',
      rows: [],
    });
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getSettlementLag).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('self-hides when only per-asset rows land without a fleet-wide aggregate', async () => {
    adminMock.getSettlementLag.mockResolvedValue({
      since: '2026-04-22T00:00:00Z',
      rows: [
        {
          assetCode: 'USDLOOP',
          sampleCount: 5,
          p50Seconds: 50,
          p95Seconds: 100,
          maxSeconds: 200,
          meanSeconds: 70,
        },
      ],
    });
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getSettlementLag).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('renders the fleet row alone when no per-asset rows are present', async () => {
    adminMock.getSettlementLag.mockResolvedValue({
      since: '2026-04-22T00:00:00Z',
      rows: [
        {
          assetCode: null,
          sampleCount: 10,
          p50Seconds: 30,
          p95Seconds: 120,
          maxSeconds: 400,
          meanSeconds: 50,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Settlement lag')).toBeDefined();
    });
    expect(screen.getByText('30s')).toBeDefined();
    // No per-asset table header.
    expect(screen.queryByText('Asset')).toBeNull();
  });
});
