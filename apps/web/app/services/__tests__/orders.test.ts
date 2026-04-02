import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));
vi.mock('~/services/api-client', () => ({
  apiRequest: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

import { createOrder, fetchOrders, fetchOrder } from '../orders';
import { authenticatedRequest } from '../api-client';

const mockAuthRequest = vi.mocked(authenticatedRequest);

describe('orders service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createOrder', () => {
    it('sends POST with order request body', async () => {
      mockAuthRequest.mockResolvedValue({ orderId: 'o-1' });
      await createOrder({ merchantId: 'm-1', amount: 25 });
      expect(mockAuthRequest).toHaveBeenCalledWith('/api/orders', {
        method: 'POST',
        body: { merchantId: 'm-1', amount: 25 },
      });
    });

    it('returns the created order response', async () => {
      const response = { orderId: 'o-1', paymentUri: 'stellar:...' };
      mockAuthRequest.mockResolvedValue(response);
      const result = await createOrder({ merchantId: 'm-1', amount: 50 });
      expect(result).toEqual(response);
    });
  });

  describe('fetchOrders', () => {
    it('calls with specified page param', async () => {
      mockAuthRequest.mockResolvedValue({ orders: [], pagination: {} });
      await fetchOrders(3);
      expect(mockAuthRequest).toHaveBeenCalledWith('/api/orders?page=3');
    });

    it('defaults to page 1', async () => {
      mockAuthRequest.mockResolvedValue({ orders: [], pagination: {} });
      await fetchOrders();
      expect(mockAuthRequest).toHaveBeenCalledWith('/api/orders?page=1');
    });

    it('returns the order list response', async () => {
      const response = { orders: [{ id: 'o-1' }], pagination: { total: 1, page: 1 } };
      mockAuthRequest.mockResolvedValue(response);
      const result = await fetchOrders(1);
      expect(result).toEqual(response);
    });
  });

  describe('fetchOrder', () => {
    it('calls with the order id', async () => {
      mockAuthRequest.mockResolvedValue({ order: { id: 'order-123' } });
      await fetchOrder('order-123');
      expect(mockAuthRequest).toHaveBeenCalledWith('/api/orders/order-123');
    });

    it('encodes the order id', async () => {
      mockAuthRequest.mockResolvedValue({ order: { id: 'a/b' } });
      await fetchOrder('a/b');
      expect(mockAuthRequest).toHaveBeenCalledWith('/api/orders/a%2Fb');
    });

    it('returns the order response', async () => {
      const response = { order: { id: 'o-1', status: 'completed' } };
      mockAuthRequest.mockResolvedValue(response);
      const result = await fetchOrder('o-1');
      expect(result).toEqual(response);
    });
  });
});
