// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { ConfigsHistoryCard, fmtRelative, truncId } from '../ConfigsHistoryCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminConfigsHistory: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminConfigsHistory: (opts?: { limit?: number }) => adminMock.getAdminConfigsHistory(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConfigsHistoryCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('truncId', () => {
  it('returns short ids unchanged', () => {
    expect(truncId('abc')).toBe('abc');
  });
  it('truncates long ids to 8 chars + ellipsis', () => {
    expect(truncId('abcdefghijklmnop')).toBe('abcdefgh…');
  });
});

describe('fmtRelative', () => {
  it('returns "just now" for a fresh timestamp', () => {
    const iso = new Date(Date.now() - 10_000).toISOString();
    expect(fmtRelative(iso)).toBe('just now');
  });
  it('returns minutes for sub-hour ages', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(fmtRelative(iso)).toMatch(/5m ago/);
  });
  it('returns em-dash for malformed input', () => {
    expect(fmtRelative('nope')).toBe('—');
  });
});

describe('<ConfigsHistoryCard />', () => {
  it('hides silently on fetch error', async () => {
    adminMock.getAdminConfigsHistory.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(adminMock.getAdminConfigsHistory).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="configs-history-heading"]')).toBeNull();
  });

  it('hides when the feed is empty', async () => {
    adminMock.getAdminConfigsHistory.mockResolvedValue({ history: [] });
    const { container } = renderCard();
    await waitFor(() => {
      expect(adminMock.getAdminConfigsHistory).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="configs-history-heading"]')).toBeNull();
  });

  it('renders one row per entry with merchant name + pct string + drill link', async () => {
    adminMock.getAdminConfigsHistory.mockResolvedValue({
      history: [
        {
          id: 'h-1',
          merchantId: 'amazon',
          merchantName: 'Amazon',
          wholesalePct: '70.00',
          userCashbackPct: '25.00',
          loopMarginPct: '5.00',
          active: true,
          changedBy: 'admin-abcdef12',
          changedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        },
        {
          id: 'h-2',
          merchantId: 'tesco',
          merchantName: 'Tesco',
          wholesalePct: '60.00',
          userCashbackPct: '30.00',
          loopMarginPct: '10.00',
          active: false,
          changedBy: 'admin-deadbeef',
          changedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
      ],
    });
    renderCard();
    await screen.findByText(/Recent config changes/i);
    expect(screen.getByText('Amazon')).toBeDefined();
    expect(screen.getByText('Tesco')).toBeDefined();
    // Pct summary reads as expected; inactive flag surfaces on Tesco.
    expect(screen.getByText(/70\.00% wholesale · 25\.00% cashback · 5\.00% margin/)).toBeDefined();
    expect(
      screen.getByText(/60\.00% wholesale · 30\.00% cashback · 10\.00% margin · inactive/),
    ).toBeDefined();
    // Drill links point at the merchant anchor on /admin/cashback.
    const amazonLink = screen.getByRole('link', { name: /Amazon/ });
    expect(amazonLink.getAttribute('href')).toBe('/admin/cashback#amazon');
  });
});
