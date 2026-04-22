// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import { AdminAuditTail, fmtRelative } from '../AdminAuditTail';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminAuditTail: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminAuditTail: (limit?: number) => adminMock.getAdminAuditTail(limit),
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
        <AdminAuditTail />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fmtRelative', () => {
  it('returns "just now" for sub-minute ages', () => {
    expect(fmtRelative(new Date().toISOString())).toBe('just now');
  });

  it('reads minutes when under an hour', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(fmtRelative(iso)).toBe('5m ago');
  });

  it('reads hours when under a day', () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(fmtRelative(iso)).toBe('3h ago');
  });

  it('reads days beyond 24 hours', () => {
    const iso = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(fmtRelative(iso)).toBe('2d ago');
  });

  it('returns em-dash for non-finite input', () => {
    expect(fmtRelative('not-a-date')).toBe('—');
  });
});

describe('<AdminAuditTail />', () => {
  it('renders rows with status + method + path + email', async () => {
    adminMock.getAdminAuditTail.mockResolvedValue({
      rows: [
        {
          actorUserId: '11111111-1111-1111-1111-111111111111',
          actorEmail: 'admin@loop.test',
          method: 'POST',
          path: '/api/admin/users/u1/credit-adjustments',
          status: 200,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText('POST')).toBeDefined();
    });
    expect(screen.getByText('200')).toBeDefined();
    expect(screen.getByText('admin@loop.test')).toBeDefined();
    expect(screen.getByText(/credit-adjustments/)).toBeDefined();
  });

  it('renders empty-state when there are no rows', async () => {
    adminMock.getAdminAuditTail.mockResolvedValue({ rows: [] });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/No admin writes yet/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.getAdminAuditTail.mockRejectedValue(new Error('boom'));
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load the audit tail/)).toBeDefined();
    });
  });
});
