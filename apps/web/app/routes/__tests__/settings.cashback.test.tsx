// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { historyMock, authMock } = vi.hoisted(() => ({
  historyMock: {
    getCashbackHistory: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/user', () => ({
  getCashbackHistory: (opts?: { limit?: number; before?: string }) =>
    historyMock.getCashbackHistory(opts),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

vi.mock('~/components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

import SettingsCashbackRoute from '../settings.cashback';

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsCashbackRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type Entry = {
  id: string;
  type: 'cashback' | 'interest' | 'spend' | 'withdrawal' | 'refund' | 'adjustment';
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
};

function mkEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? 'tx-' + Math.random().toString(36).slice(2, 8),
    type: overrides.type ?? 'cashback',
    amountMinor: overrides.amountMinor ?? '150',
    currency: overrides.currency ?? 'USD',
    referenceType: overrides.referenceType ?? 'order',
    referenceId: overrides.referenceId ?? 'abcd1234ef',
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00.000Z',
  };
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  historyMock.getCashbackHistory.mockReset();
});

afterEach(cleanup);

describe('SettingsCashbackRoute', () => {
  it('shows the sign-in prompt when unauthenticated', async () => {
    authMock.isAuthenticated = false;
    renderPage();
    expect(await screen.findByText(/Sign in to see your cashback activity/i)).toBeTruthy();
    expect(historyMock.getCashbackHistory).not.toHaveBeenCalled();
  });

  it('renders the empty state when the first page returns no rows', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText(/No cashback activity yet/i)).toBeTruthy();
  });

  it('renders the entries list with formatted amount + label', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({
      entries: [
        mkEntry({ id: 'tx-a', type: 'cashback', amountMinor: '250', currency: 'USD' }),
        mkEntry({
          id: 'tx-b',
          type: 'withdrawal',
          amountMinor: '-100',
          currency: 'USD',
          referenceType: null,
          referenceId: null,
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText(/Cashback/)).toBeTruthy();
    expect(await screen.findByText(/Withdrawal/)).toBeTruthy();
  });

  it('shows Load more when the server returns a full page and fetches the next cursor when clicked', async () => {
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      mkEntry({
        id: `first-${i}`,
        createdAt: `2026-04-${String(20 - (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );
    const secondPage = [mkEntry({ id: 'second-1' })];
    historyMock.getCashbackHistory
      .mockResolvedValueOnce({ entries: firstPage })
      .mockResolvedValueOnce({ entries: secondPage });

    renderPage();

    const loadMore = await screen.findByRole('button', { name: /Load more/i });
    await act(async () => {
      fireEvent.click(loadMore);
    });

    await waitFor(() => {
      expect(historyMock.getCashbackHistory).toHaveBeenCalledTimes(2);
    });
    // Second call should pass the `before` cursor from the last row of page 1.
    const secondCall = historyMock.getCashbackHistory.mock.calls[1]?.[0];
    expect(secondCall?.before).toBe(firstPage[firstPage.length - 1]?.createdAt);
  });

  it('hides Load more when the first page returns fewer rows than the page size', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [mkEntry()] });
    renderPage();
    await screen.findByText(/Cashback/);
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
  });

  it('surfaces an error message when the fetch fails', async () => {
    historyMock.getCashbackHistory.mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByText(/Couldn.+t load this page/i)).toBeTruthy();
  });
});
