// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { AdminPayoutView } from '~/services/admin';
import { UserPayoutsTable, fmtStroops } from '../UserPayoutsTable';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    listPayouts: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listPayouts: (opts: unknown) => adminMock.listPayouts(opts),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderTable(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserPayoutsTable userId="u1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<AdminPayoutView> = {}): AdminPayoutView {
  return {
    id: overrides.id ?? 'payout1234',
    userId: 'u1',
    orderId: 'order-1',
    assetCode: overrides.assetCode ?? 'GBPLOOP',
    assetIssuer: 'GISSUER',
    toAddress: 'GDEST',
    amountStroops: overrides.amountStroops ?? '12500000',
    memoText: 'memo',
    state: overrides.state ?? 'confirmed',
    txHash: overrides.txHash ?? 'tx',
    lastError: null,
    attempts: overrides.attempts ?? 1,
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00.000Z',
    submittedAt: '2026-04-20T10:01:00.000Z',
    confirmedAt: '2026-04-20T10:02:00.000Z',
    failedAt: null,
  };
}

describe('fmtStroops', () => {
  it('trims trailing zeros', () => {
    expect(fmtStroops('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtStroops('garbage', 'GBPLOOP')).toBe('—');
  });
});

describe('<UserPayoutsTable />', () => {
  it('renders a payout row with asset + state + deep link', async () => {
    adminMock.listPayouts.mockResolvedValue({
      payouts: [row({ id: 'abcd1234efgh' })],
    });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText('abcd1234')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: 'abcd1234' });
    expect(link.getAttribute('href')).toBe('/admin/payouts/abcd1234efgh');
    expect(screen.getByText(/confirmed/)).toBeDefined();
  });

  it('passes userId to listPayouts', async () => {
    adminMock.listPayouts.mockResolvedValue({ payouts: [] });
    renderTable();
    await waitFor(() => {
      expect(adminMock.listPayouts).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
    });
  });

  it('renders empty-state when user has no payouts', async () => {
    adminMock.listPayouts.mockResolvedValue({ payouts: [] });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/No on-chain payouts for this user yet/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.listPayouts.mockRejectedValue(new Error('boom'));
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payouts/)).toBeDefined();
    });
  });
});
