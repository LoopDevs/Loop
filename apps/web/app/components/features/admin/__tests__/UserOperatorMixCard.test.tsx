// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { UserOperatorMixCard } from '../UserOperatorMixCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getUserOperatorMix: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getUserOperatorMix: (id: string, opts?: unknown) => adminMock.getUserOperatorMix(id, opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function renderCard(userId = VALID_UUID): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserOperatorMixCard userId={userId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<UserOperatorMixCard />', () => {
  it('renders the empty-state when no operator has carried an order for the user', async () => {
    adminMock.getUserOperatorMix.mockResolvedValue({
      userId: VALID_UUID,
      since: '',
      rows: [],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No CTX operator has carried an order for this user/i)).toBeDefined();
    });
  });

  it('renders an inline error line on fetch failure', async () => {
    adminMock.getUserOperatorMix.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load operator mix for this user/i)).toBeDefined();
    });
  });

  it('renders rows with operator-drill + per-(user, operator) failed-triage links', async () => {
    adminMock.getUserOperatorMix.mockResolvedValue({
      userId: VALID_UUID,
      since: '',
      rows: [
        {
          operatorId: 'op-beta-02',
          orderCount: 8,
          fulfilledCount: 6,
          failedCount: 2,
          lastOrderAt: new Date().toISOString(),
        },
      ],
    });
    renderCard();

    await waitFor(() => {
      expect(screen.getByText('op-beta-02')).toBeDefined();
    });

    const drill = screen.getByRole('link', { name: /open operator detail for op-beta-02/i });
    expect(drill.getAttribute('href')).toBe('/admin/operators/op-beta-02');

    const failed = screen.getByRole('link', {
      name: /review 2 failed orders for this user carried by op-beta-02/i,
    });
    expect(failed.getAttribute('href')).toBe(
      `/admin/orders?state=failed&userId=${VALID_UUID}&ctxOperatorId=op-beta-02`,
    );

    // Success rate to 1dp.
    expect(screen.getByText('75.0%')).toBeDefined();
  });
});
