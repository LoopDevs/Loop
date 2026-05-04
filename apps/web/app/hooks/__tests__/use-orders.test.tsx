// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { ordersMock } = vi.hoisted(() => ({
  ordersMock: {
    fetchOrders: vi.fn(),
    fetchOrder: vi.fn(),
  },
}));

vi.mock('~/services/orders', () => ({
  fetchOrders: (page: number) => ordersMock.fetchOrders(page),
  fetchOrder: (id: string) => ordersMock.fetchOrder(id),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import { useOrders, useOrder } from '../use-orders';

afterEach(cleanup);

beforeEach(() => {
  ordersMock.fetchOrders.mockReset();
  ordersMock.fetchOrder.mockReset();
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

function DetailProbe(props: { id: string; isAuthed: boolean }): React.ReactElement {
  const r = useOrder(props.id, props.isAuthed);
  return (
    <div>
      <span data-testid="loading">{r.isLoading ? 'true' : 'false'}</span>
      <span data-testid="id">{r.order?.id ?? '_none_'}</span>
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

describe('useOrder', () => {
  it('does not fire when id is empty after trim', () => {
    render(withProvider(<DetailProbe id="   " isAuthed={true} />));
    expect(ordersMock.fetchOrder).not.toHaveBeenCalled();
  });

  it('does not fire when isAuthenticated=false', () => {
    render(withProvider(<DetailProbe id="o-1" isAuthed={false} />));
    expect(ordersMock.fetchOrder).not.toHaveBeenCalled();
  });

  it('fetches with the trimmed id and returns the order', async () => {
    ordersMock.fetchOrder.mockResolvedValue({ order: { id: 'o-1' } });
    render(withProvider(<DetailProbe id="  o-1  " isAuthed={true} />));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(ordersMock.fetchOrder).toHaveBeenCalledWith('o-1');
    expect(screen.getByTestId('id').textContent).toBe('o-1');
  });
});
