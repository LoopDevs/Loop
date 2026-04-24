// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { AdminAuditTailRow } from '~/services/admin';
import AdminAuditRoute from '../admin.audit';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminAuditTail: vi.fn<(opts?: { limit?: number; before?: string } | number) => unknown>(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminAuditTail: (opts?: { limit?: number; before?: string } | number) =>
      adminMock.getAdminAuditTail(opts),
    getTreasurySnapshot: vi.fn().mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {},
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: {},
      operatorPool: { size: 0, operators: [] },
    }),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// A2-1101: RequireAdmin gates the shell on /api/users/me.isAdmin —
// admin routes can't render without a successful getMe() returning
// isAdmin:true. Tests that want to exercise the denial banner can
// override by resetting this mock per-test.
import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'u1',
      email: 'admin@loop.test',
      isAdmin: true,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminAuditRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<AdminAuditTailRow> = {}): AdminAuditTailRow {
  return {
    actorUserId: overrides.actorUserId ?? 'a1111111-2222-3333-4444-555555555555',
    actorEmail: overrides.actorEmail ?? 'admin@loop.test',
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/api/admin/payouts/abcd/retry',
    status: overrides.status ?? 200,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe('<AdminAuditRoute />', () => {
  it('renders an empty-state message when no admin writes exist', async () => {
    adminMock.getAdminAuditTail.mockResolvedValue({ rows: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No admin writes recorded yet/i)).toBeDefined();
    });
  });

  it('renders a row with the actor email and a deep-link to the resource', async () => {
    adminMock.getAdminAuditTail.mockResolvedValue({
      rows: [
        row({
          path: '/api/admin/users/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/credit-adjustments',
          method: 'POST',
          actorEmail: 'ash@loop.test',
        }),
      ],
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('ash@loop.test')).toBeDefined();
    });
    const pathLink = screen.getByRole('link', {
      name: '/api/admin/users/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/credit-adjustments',
    });
    expect(pathLink.getAttribute('href')).toBe('/admin/users/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('shows Load more when the page is full and wires the cursor through on click', async () => {
    const pageOne = Array.from({ length: 50 }, (_, i) =>
      row({
        createdAt: new Date(2026, 3, 22, 12, 0, i).toISOString(),
        actorEmail: `admin-${i}@loop.test`,
      }),
    );
    adminMock.getAdminAuditTail.mockResolvedValueOnce({ rows: pageOne });
    renderPage();
    const loadMore = await screen.findByRole('button', { name: /load more/i });

    const oldestCreatedAt = pageOne[pageOne.length - 1]!.createdAt;
    adminMock.getAdminAuditTail.mockResolvedValueOnce({
      rows: [row({ actorEmail: 'oldest@loop.test' })],
    });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('oldest@loop.test')).toBeDefined();
    });
    // Some call after page 1 must have forwarded the cursor from the
    // end of page 1 as `before` — don't care which index, just that
    // the pagination wire is connected.
    const beforeValues = adminMock.getAdminAuditTail.mock.calls
      .map((c) => (c[0] as { before?: string } | undefined)?.before)
      .filter((v): v is string => v !== undefined);
    expect(beforeValues).toContain(oldestCreatedAt);
  });

  it('surfaces an admin-gate denial message on 401', async () => {
    const { ApiException } = await import('@loop/shared');
    adminMock.getAdminAuditTail.mockRejectedValueOnce(
      new ApiException(401, { code: 'UNAUTHORIZED', message: 'nope' }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Only admins can view the audit trail/i)).toBeDefined();
    });
  });
});
