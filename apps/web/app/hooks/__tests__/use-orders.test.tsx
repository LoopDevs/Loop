// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { ordersMock } = vi.hoisted(() => ({
  ordersMock: {
    fetchOrders: vi.fn(),
  },
}));

vi.mock('~/services/orders', () => ({
  fetchOrders: (page: number) => ordersMock.fetchOrders(page),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useOrders } from '../use-orders';

afterEach(cleanup);

beforeEach(() => {
  ordersMock.fetchOrders.mockReset();
});

function ListProbe(props: { page: number; isAuthed: boolean }): React.ReactElement {
  const r = useOrders(props.page, props.isAuthed);
  return (
    <div>
      <span data-testid="loading">{r.isLoading ? 'true' : 'false'}</span>
      <span data-testid="count">{r.orders.length}</span>
      <span data-testid="hasNext">{String(r.hasNext)}</span>
      <span data-testid="total">{r.total}</span>
    </div>
  );
}

function withProvider(node: React.ReactElement): React.ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, throwOnError: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe('useOrders', () => {
  it('does not fire fetchOrders when isAuthenticated=false', () => {
    render(withProvider(<ListProbe page={1} isAuthed={false} />));
    expect(ordersMock.fetchOrders).not.toHaveBeenCalled();
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('returns the page rows + pagination flags after the query resolves', async () => {
    ordersMock.fetchOrders.mockResolvedValue({
      orders: [{ id: 'o-1' }, { id: 'o-2' }],
      pagination: { page: 1, limit: 20, total: 5, totalPages: 1, hasNext: false, hasPrev: false },
    });
    render(withProvider(<ListProbe page={1} isAuthed={true} />));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(screen.getByTestId('hasNext').textContent).toBe('false');
    expect(screen.getByTestId('total').textContent).toBe('5');
  });

  it('fires a fresh request when page changes (cache key includes page)', async () => {
    ordersMock.fetchOrders.mockResolvedValue({
      orders: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
    });
    const { rerender } = render(withProvider(<ListProbe page={1} isAuthed={true} />));
    await waitFor(() => expect(ordersMock.fetchOrders).toHaveBeenCalledWith(1));
    rerender(withProvider(<ListProbe page={2} isAuthed={true} />));
    await waitFor(() => expect(ordersMock.fetchOrders).toHaveBeenCalledWith(2));
  });
});
