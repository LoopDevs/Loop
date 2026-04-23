// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { PendingCashbackChip, formatOldestAgo, stroopsToMinor } from '../PendingCashbackChip';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: { getUserPendingPayoutsSummary: vi.fn() },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserPendingPayoutsSummary: () => userMock.getUserPendingPayoutsSummary(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChip(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <PendingCashbackChip />
    </QueryClientProvider>,
  );
  return container;
}

describe('stroopsToMinor', () => {
  it('converts whole-fiat amounts (100_000 stroops = 1 minor)', () => {
    expect(stroopsToMinor('100000')).toBe(1n);
    expect(stroopsToMinor('12500000')).toBe(125n);
    expect(stroopsToMinor('0')).toBe(0n);
  });

  it('returns 0n on malformed input rather than throwing', () => {
    expect(stroopsToMinor('not-a-number')).toBe(0n);
  });
});

describe('formatOldestAgo', () => {
  it('formats seconds / minutes / hours / days', () => {
    const now = 1_000_000_000_000;
    expect(formatOldestAgo(new Date(now - 10_000).toISOString(), now)).toBe('10s');
    expect(formatOldestAgo(new Date(now - 300_000).toISOString(), now)).toBe('5 min');
    expect(formatOldestAgo(new Date(now - 7_200_000).toISOString(), now)).toBe('2h');
    expect(formatOldestAgo(new Date(now - 3 * 24 * 3600_000).toISOString(), now)).toBe('3d');
  });
});

describe('<PendingCashbackChip />', () => {
  it('renders per-asset totals when the summary has rows', async () => {
    userMock.getUserPendingPayoutsSummary.mockResolvedValue({
      rows: [
        {
          assetCode: 'USDLOOP',
          state: 'pending',
          count: 2,
          totalStroops: '1250000000', // 12_500 minor = $125
          oldestCreatedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        {
          assetCode: 'USDLOOP',
          state: 'submitted',
          count: 1,
          totalStroops: '500000000', // 5000 minor = $50
          oldestCreatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    renderChip();
    await waitFor(() => {
      expect(screen.getByText(/Cashback settling/i)).toBeDefined();
    });
    expect(screen.getByText('USDLOOP')).toBeDefined();
    // $125 + $50 = $175 rolled up.
    expect(screen.getByText('$175.00')).toBeDefined();
  });

  it('shows one line per LOOP asset and sorts codes alphabetically', async () => {
    userMock.getUserPendingPayoutsSummary.mockResolvedValue({
      rows: [
        {
          assetCode: 'USDLOOP',
          state: 'pending',
          count: 1,
          totalStroops: '100000000', // 1000 minor = $10
          oldestCreatedAt: new Date().toISOString(),
        },
        {
          assetCode: 'GBPLOOP',
          state: 'pending',
          count: 1,
          totalStroops: '200000000', // 2000 minor = £20
          oldestCreatedAt: new Date().toISOString(),
        },
      ],
    });
    renderChip();
    await waitFor(() => {
      expect(screen.getByText('GBPLOOP')).toBeDefined();
    });
    expect(screen.getByText('USDLOOP')).toBeDefined();
    expect(screen.getByText('£20.00')).toBeDefined();
    expect(screen.getByText('$10.00')).toBeDefined();
    // GBPLOOP appears before USDLOOP in the rendered order.
    const labels = screen.getAllByText(/LOOP$/);
    expect(labels[0]!.textContent).toBe('GBPLOOP');
    expect(labels[1]!.textContent).toBe('USDLOOP');
  });

  it('ignores unrecognized asset codes (defensive — unconfigured LOOP assets)', async () => {
    userMock.getUserPendingPayoutsSummary.mockResolvedValue({
      rows: [
        {
          assetCode: 'JPYLOOP',
          state: 'pending',
          count: 1,
          totalStroops: '100000000',
          oldestCreatedAt: new Date().toISOString(),
        },
      ],
    });
    const container = renderChip();
    await waitFor(() => {
      expect(userMock.getUserPendingPayoutsSummary).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('self-hides on empty response (user has no in-flight cashback)', async () => {
    userMock.getUserPendingPayoutsSummary.mockResolvedValue({ rows: [] });
    const container = renderChip();
    await waitFor(() => {
      expect(userMock.getUserPendingPayoutsSummary).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('self-hides on error (balance card already covers the surface)', async () => {
    userMock.getUserPendingPayoutsSummary.mockRejectedValue(new Error('boom'));
    const container = renderChip();
    await waitFor(() => {
      expect(userMock.getUserPendingPayoutsSummary).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
