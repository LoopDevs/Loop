// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { TopUsersTable, fmtPositiveMinor } from '../TopUsersTable';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getTopUsers: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTopUsers: () => adminMock.getTopUsers(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderComponent(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TopUsersTable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtPositiveMinor', () => {
  it('formats GBP minor units as localized currency', () => {
    expect(fmtPositiveMinor('500', 'GBP')).toMatch(/5\.00/);
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtPositiveMinor('not-a-number', 'GBP')).toBe('—');
  });

  it('never renders a leading + even on positive amounts', () => {
    expect(fmtPositiveMinor('1000', 'USD')).not.toMatch(/^\+/);
  });
});

describe('<TopUsersTable />', () => {
  it('renders ranked rows with email link + earned amount', async () => {
    adminMock.getTopUsers.mockResolvedValue({
      since: '2026-03-23T00:00:00.000Z',
      rows: [
        {
          userId: 'u1',
          email: 'top@loop.test',
          currency: 'GBP',
          count: 7,
          amountMinor: '12500',
        },
        {
          userId: 'u2',
          email: 'next@loop.test',
          currency: 'USD',
          count: 5,
          amountMinor: '4200',
        },
      ],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('top@loop.test')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: 'top@loop.test' });
    expect(link.getAttribute('href')).toBe('/admin/users/u1');
    expect(screen.getByText(/125\.00/)).toBeDefined();
    // Rank numbers: 1 and 2 present.
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('surfaces an empty-state message when no activity in window', async () => {
    adminMock.getTopUsers.mockResolvedValue({
      since: '2026-03-23T00:00:00.000Z',
      rows: [],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/No cashback activity in the last 30 days/)).toBeDefined();
    });
  });

  it('surfaces an error message on fetch failure', async () => {
    adminMock.getTopUsers.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load top users/)).toBeDefined();
    });
  });
});
