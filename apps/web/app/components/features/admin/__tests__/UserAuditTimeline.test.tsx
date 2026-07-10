// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { AdminAuditTimelineEvent } from '~/services/admin';
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
    adminMock.getAdminUserAuditTimeline.mockResolvedValue({ userId: 'u1', events: [orderEvent()] });
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Order abcd1234… — fulfilled/)).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /Order abcd1234… — fulfilled/ });
    expect(link.getAttribute('href')).toBe('/admin/orders/abcd1234efgh');
  });

  it('renders a payout event that drill-links to the payout detail page', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue({
      userId: 'u1',
      events: [
        {
          kind: 'payout',
          at: '2026-07-05T00:00:00.000Z',
          summary: 'Payout xyz98765… — confirmed (order_cashback)',
          refType: 'payout',
          refId: 'xyz98765wxyz',
          detail: { state: 'confirmed' },
        },
      ],
    });
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Payout xyz98765… — confirmed/)).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /Payout xyz98765… — confirmed/ });
    expect(link.getAttribute('href')).toBe('/admin/payouts/xyz98765wxyz');
  });

  it('renders a non-drillable event (admin action) as plain text, no link', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue({
      userId: 'u1',
      events: [
        {
          kind: 'admin_action',
          at: '2026-07-04T00:00:00.000Z',
          summary: 'POST /api/admin/users/u1/credit-adjustments → 200',
          refType: null,
          refId: null,
          detail: { actorEmail: 'admin@loop.test' },
        },
      ],
    });
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/credit-adjustments/)).toBeDefined();
    });
    expect(screen.queryByRole('link', { name: /credit-adjustments/ })).toBeNull();
  });

  // Money-review finding: this component's default `limit` MUST match
  // the backend's `DEFAULT_PER_SOURCE_LIMIT` (8) — that's the value
  // the CF-10 bulk-read-tripwire safety margin in
  // `admin/user-audit-timeline.ts` (5 sources × 8 + 1 = 41, under the
  // 50-row global threshold) is computed against. A higher default
  // here would silently blow past that margin on every real page
  // load.
  it('requests the backend default per-source limit (8), matching the CF-10 safety margin', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue({ userId: 'u1', events: [] });
    renderTimeline();
    await waitFor(() => {
      expect(adminMock.getAdminUserAuditTimeline).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ limit: 8 }),
      );
    });
  });

  it('surfaces an empty-state when the user has no timeline events', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValue({ userId: 'u1', events: [] });
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

  it('pages older on "Older →" using the last event\'s `at` as the cursor', async () => {
    adminMock.getAdminUserAuditTimeline.mockResolvedValueOnce({
      userId: 'u1',
      events: [orderEvent()],
    });
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText(/Order abcd1234…/)).toBeDefined();
    });

    adminMock.getAdminUserAuditTimeline.mockResolvedValueOnce({ userId: 'u1', events: [] });
    screen.getByRole('button', { name: /Older/i }).click();

    await waitFor(() => {
      expect(adminMock.getAdminUserAuditTimeline).toHaveBeenLastCalledWith(
        'u1',
        expect.objectContaining({ before: '2026-07-06T00:00:00.000Z' }),
      );
    });
  });
});
