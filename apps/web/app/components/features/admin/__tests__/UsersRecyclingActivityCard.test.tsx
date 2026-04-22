// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { UsersRecyclingActivityCard, formatRelative } from '../UsersRecyclingActivityCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUsersRecyclingActivity: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUsersRecyclingActivity: (opts?: { limit?: number }) =>
      adminMock.getAdminUsersRecyclingActivity(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <UsersRecyclingActivityCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('formatRelative', () => {
  it('renders minutes / hours / days buckets', () => {
    const now = Date.now();
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(formatRelative(new Date(now - 3 * 60 * 60_000).toISOString())).toBe('3h ago');
    expect(formatRelative(new Date(now - 2 * 24 * 60 * 60_000).toISOString())).toBe('2d ago');
  });

  it('uses a locale date past 7 days', () => {
    const out = formatRelative(new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString());
    // Locale-dependent; assert it's not the relative-style string.
    expect(out).not.toMatch(/\d+[mhd] ago/);
  });

  it('bails on malformed input', () => {
    expect(formatRelative('not-a-date')).toBe('not-a-date');
  });
});

describe('<UsersRecyclingActivityCard />', () => {
  it('renders the empty-state line when no users are recycling', async () => {
    adminMock.getAdminUsersRecyclingActivity.mockResolvedValue({
      since: '2026-01-22T00:00:00.000Z',
      rows: [],
    });
    renderCard();
    await waitFor(() => {
      expect(
        screen.getByText(/No users have recycled cashback in the last 90 days/i),
      ).toBeDefined();
    });
  });

  it('silently hides on fetch error', async () => {
    adminMock.getAdminUsersRecyclingActivity.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('table')).toBeNull();
    });
  });

  it('renders one row per recycling user with a drill-down link', async () => {
    adminMock.getAdminUsersRecyclingActivity.mockResolvedValue({
      since: '2026-01-22T00:00:00.000Z',
      rows: [
        {
          userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          email: 'alice@example.com',
          currency: 'GBP',
          lastRecycledAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          recycledOrderCount: 4,
          recycledChargeMinor: '12000',
        },
        {
          userId: '11111111-2222-3333-4444-555555555555',
          email: 'bob@example.com',
          currency: 'USD',
          lastRecycledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          recycledOrderCount: 2,
          recycledChargeMinor: '3000',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeDefined();
    });
    expect(screen.getByText('bob@example.com')).toBeDefined();
    // Drill link href.
    const aliceLink = screen.getByText('alice@example.com').closest('a');
    expect(aliceLink?.getAttribute('href')).toBe(
      '/admin/users/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    // Currency-formatted spent.
    expect(screen.getByText(/120\.00/)).toBeDefined();
    expect(screen.getByText(/30\.00/)).toBeDefined();
    // Relative-time surfaces.
    expect(screen.getByText('5m ago')).toBeDefined();
    expect(screen.getByText('2h ago')).toBeDefined();
  });

  it('renders em-dash for malformed chargeMinor (defensive)', async () => {
    adminMock.getAdminUsersRecyclingActivity.mockResolvedValue({
      since: '2026-01-22T00:00:00.000Z',
      rows: [
        {
          userId: 'bad-user',
          email: 'bad@example.com',
          currency: 'GBP',
          lastRecycledAt: new Date().toISOString(),
          recycledOrderCount: 1,
          recycledChargeMinor: 'not-a-bigint',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('bad@example.com')).toBeDefined();
    });
    expect(screen.getByText('—')).toBeDefined();
  });
});
