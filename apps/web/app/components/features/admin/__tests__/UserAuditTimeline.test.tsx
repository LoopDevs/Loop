// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type {
  AdminAuditTimelineCursors,
  AdminAuditTimelineEvent,
  AdminUserAuditTimelineResponse,
} from '~/services/admin';
import { UserAuditTimeline } from '../UserAuditTimeline';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserAuditTimeline: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserAuditTimeline: (userId: string, opts: unknown) =>
      adminMock.getAdminUserAuditTimeline(userId, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

const NULL_CURSORS: AdminAuditTimelineCursors = {
  adminActions: null,
  ledger: null,
  orders: null,
  payouts: null,
  sessions: null,
};

function page(
  events: AdminAuditTimelineEvent[],
  nextCursors: AdminAuditTimelineCursors = NULL_CURSORS,
): AdminUserAuditTimelineResponse {
  return { userId: 'u1', events, nextCursors };
}

function renderTimeline(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserAuditTimeline userId="u1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function orderEvent(overrides: Partial<AdminAuditTimelineEvent> = {}): AdminAuditTimelineEvent {
  return {
    kind: 'order',
    at: '2026-07-06T00:00:00.000Z',
    summary: 'Order abcd1234… — fulfilled',
    refType: 'order',
    refId: 'abcd1234efgh',
    detail: { state: 'fulfilled' },
    ...overrides,
  };
}

describe('<UserAuditTimeline />', () => {
  it('renders an order event that drill-links to the order detail page', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(page([orderEvent()]));
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Order abcd1234… — fulfilled/)).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /Order abcd1234… — fulfilled/ });
    expect(link.getAttribute('href')).toBe('/admin/orders/abcd1234efgh');
  });

  it('renders a payout event that drill-links to the payout detail page', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(
      page([
        {
          kind: 'payout',
          at: '2026-07-05T00:00:00.000Z',
          summary: 'Payout xyz98765… — confirmed (order_cashback)',
          refType: 'payout',
          refId: 'xyz98765wxyz',
          detail: { state: 'confirmed' },
        },
      ]),
    );
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Payout xyz98765… — confirmed/)).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /Payout xyz98765… — confirmed/ });
    expect(link.getAttribute('href')).toBe('/admin/payouts/xyz98765wxyz');
  });

  it('renders a non-drillable event (admin action) as plain text, no link', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(
      page([
        {
          kind: 'admin_action',
          at: '2026-07-04T00:00:00.000Z',
          summary: 'POST /api/admin/users/u1/credit-adjustments → 200',
          refType: null,
          refId: null,
          detail: { actorEmail: 'admin@loop.test' },
        },
      ]),
    );
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/credit-adjustments/)).toBeDefined();
    });
    expect(screen.queryByRole('link', { name: /credit-adjustments/ })).toBeNull();
  });

  it('surfaces an empty-state when the user has no timeline events', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(page([]));
    renderTimeline();
    await waitFor(() => {
      expect(
        screen.getByText(/No admin actions, money movements, or session events/),
      ).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.getAdminUserAuditTimeline.mockRejectedValue(new Error('boom'));
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load the audit timeline/)).toBeDefined();
    });
  });

  // Money-review finding: this component's default `limit` MUST match
  // the backend's `DEFAULT_PER_SOURCE_LIMIT` (8) — the value the CF-10
  // bulk-read-tripwire safety margin (5 sources × 8 + 1 = 41, under
  // 50) is computed against. A higher default here would silently blow
  // past that margin on every real page load. Page 1 sends no cursors.
  it('requests the backend default per-source limit (8) with no cursors on page 1', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(page([]));
    renderTimeline();
    await waitFor(() => {
      expect(adminMock.getAdminUserAuditTimeline).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ limit: 8, cursors: null }),
      );
    });
  });

  // The P1 fix, from the client's side: "Load older" echoes the prior
  // page's PER-SOURCE `nextCursors` back (not one shared cursor), and
  // the newly-returned rows accumulate into the list rather than
  // replacing it.
  it('pages older with the prior page’s per-source cursors and accumulates rows', async () => {
    const page1Cursors: AdminAuditTimelineCursors = {
      ...NULL_CURSORS,
      ledger: '2026-07-05T00:00:00.000Z',
    };
    // Keyed on the cursors arg (robust to react-query refetching page 1):
    // page 1 (cursors null) returns the order + a live ledger cursor;
    // any paged call (cursors present) returns the older ledger row.
    adminMock.getAdminUserAuditTimeline.mockImplementation(
      (_userId: string, opts: { cursors?: AdminAuditTimelineCursors | null }) =>
        opts.cursors === null || opts.cursors === undefined
          ? Promise.resolve(
              page([orderEvent({ refId: 'order-1', summary: 'Order 1' })], page1Cursors),
            )
          : Promise.resolve(
              page([
                {
                  kind: 'ledger',
                  at: '2026-07-04T00:00:00.000Z',
                  summary: 'cashback 100 USD',
                  refType: null,
                  refId: null,
                  detail: { transactionId: 'tx-older' },
                },
              ]),
            ),
    );

    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Order 1/)).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Load older/i }));

    await waitFor(() => {
      // "Load older" echoes the per-source cursors object back verbatim
      // (not one shared cursor).
      expect(adminMock.getAdminUserAuditTimeline).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ limit: 8, cursors: page1Cursors }),
      );
    });
    // Accumulation, not replacement: page-1 order AND page-2 ledger row
    // are both on screen.
    await waitFor(() => {
      expect(screen.getByText(/Order 1/)).toBeDefined();
      expect(screen.getByText(/cashback 100 USD/)).toBeDefined();
    });
  });

  it('hides "Load older" once every source cursor is null (exhausted)', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue(page([orderEvent()], NULL_CURSORS));
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Order abcd1234…/)).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /Load older/i })).toBeNull();
  });
});
