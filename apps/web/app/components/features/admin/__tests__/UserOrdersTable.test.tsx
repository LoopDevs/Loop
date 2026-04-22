// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { AdminOrderView } from '~/services/admin';
import { UserOrdersTable, fmtMinor } from '../UserOrdersTable';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    listAdminOrders: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listAdminOrders: (opts: unknown) => adminMock.listAdminOrders(opts),
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
        <UserOrdersTable userId="u1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<AdminOrderView> = {}): AdminOrderView {
  return {
    id: overrides.id ?? 'order123abcdef',
    userId: 'u1',
    merchantId: overrides.merchantId ?? 'mer-1',
    state: overrides.state ?? 'fulfilled',
    currency: 'GBP',
    faceValueMinor: '10000',
    chargeCurrency: 'GBP',
    chargeMinor: overrides.chargeMinor ?? '10000',
    paymentMethod: 'credit',
    wholesalePct: '80.00',
    userCashbackPct: '10.00',
    loopMarginPct: '10.00',
    wholesaleMinor: '8000',
    userCashbackMinor: overrides.userCashbackMinor ?? '1000',
    loopMarginMinor: '1000',
    ctxOrderId: null,
    ctxOperatorId: null,
    failureReason: null,
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00.000Z',
    paidAt: null,
    procuredAt: null,
    fulfilledAt: null,
    failedAt: null,
  };
}

describe('fmtMinor', () => {
  it('renders localized currency', () => {
    expect(fmtMinor('10000', 'GBP')).toMatch(/100\.00/);
  });

  it('returns em-dash for bad input', () => {
    expect(fmtMinor('abc', 'GBP')).toBe('—');
  });
});

describe('<UserOrdersTable />', () => {
  it('renders an order row with charge + cashback + state + id link', async () => {
    adminMock.listAdminOrders.mockResolvedValue({
      orders: [row({ id: 'abcd1234efgh' })],
    });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText('abcd1234')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: 'abcd1234' });
    expect(link.getAttribute('href')).toBe('/admin/orders/abcd1234efgh');
    expect(screen.getByText(/fulfilled/)).toBeDefined();
  });

  it('surfaces an empty-state when the user has no orders', async () => {
    adminMock.listAdminOrders.mockResolvedValue({ orders: [] });
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/No orders on this account yet/)).toBeDefined();
    });
  });

  it('surfaces an error banner on fetch failure', async () => {
    adminMock.listAdminOrders.mockRejectedValue(new Error('boom'));
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load orders/)).toBeDefined();
    });
  });
});
