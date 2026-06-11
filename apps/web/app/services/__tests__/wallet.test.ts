import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api-client', () => ({
  authenticatedRequest: vi.fn(),
}));

import {
  getMyWallet,
  payLoopOrderWithBalance,
  balanceToStroops,
  minorToStroops,
  loopBalanceCoversCharge,
} from '../wallet';
import { authenticatedRequest } from '../api-client';

const mockAuth = vi.mocked(authenticatedRequest);

beforeEach(() => {
  mockAuth.mockReset();
});

/**
 * ADR 030 Phase C — thin wrappers around `authenticatedRequest`, so
 * the tests pin the exact path / method (the silent-drift class), plus
 * the pure stroops cover-math the checkout button decides on.
 */

describe('getMyWallet', () => {
  it('GETs /api/me/wallet and returns the payload', async () => {
    const payload = {
      address: 'GABC',
      provisioning: 'activated',
      balances: [{ assetCode: 'GBPLOOP', balance: '12.5000000' }],
      interestApyBps: 300,
    };
    mockAuth.mockResolvedValue(payload);
    const result = await getMyWallet();
    expect(mockAuth).toHaveBeenCalledWith('/api/me/wallet');
    expect(result).toEqual(payload);
  });
});

describe('payLoopOrderWithBalance', () => {
  it('POSTs /api/orders/loop/:id/pay-with-balance', async () => {
    mockAuth.mockResolvedValue({ state: 'paid' });
    const result = await payLoopOrderWithBalance('order-123');
    expect(mockAuth).toHaveBeenCalledWith('/api/orders/loop/order-123/pay-with-balance', {
      method: 'POST',
    });
    expect(result).toEqual({ state: 'paid' });
  });

  it('URI-encodes the order id', async () => {
    mockAuth.mockResolvedValue({ state: 'paid' });
    await payLoopOrderWithBalance('a/b');
    expect(mockAuth).toHaveBeenCalledWith('/api/orders/loop/a%2Fb/pay-with-balance', {
      method: 'POST',
    });
  });
});

describe('balanceToStroops', () => {
  it('converts Horizon decimal strings to stroops', () => {
    expect(balanceToStroops('42.5000000')).toBe(425_000_000n);
    expect(balanceToStroops('0.0000001')).toBe(1n);
    expect(balanceToStroops('10')).toBe(100_000_000n);
    expect(balanceToStroops('0.5')).toBe(5_000_000n);
  });

  it('returns null for malformed input', () => {
    expect(balanceToStroops('')).toBeNull();
    expect(balanceToStroops('abc')).toBeNull();
    expect(balanceToStroops('1.23456789')).toBeNull(); // >7 fractional digits
    expect(balanceToStroops('1e5')).toBeNull();
  });
});

describe('minorToStroops', () => {
  it('converts 2-dp minor units to stroops', () => {
    expect(minorToStroops('1250')).toBe(125_000_000n);
    expect(minorToStroops(1)).toBe(100_000n);
  });

  it('returns null for malformed input', () => {
    expect(minorToStroops('12.5')).toBeNull();
    expect(minorToStroops('x')).toBeNull();
  });
});

describe('loopBalanceCoversCharge', () => {
  it('true when balance ≥ charge (units normalised)', () => {
    // £12.50 balance vs £12.50 charge — exact cover.
    expect(loopBalanceCoversCharge('12.5000000', '1250')).toBe(true);
    expect(loopBalanceCoversCharge('12.5000001', '1250')).toBe(true);
  });

  it('false when balance < charge', () => {
    expect(loopBalanceCoversCharge('12.4999999', '1250')).toBe(false);
    expect(loopBalanceCoversCharge('0.0000000', '1')).toBe(false);
  });

  it('false (never throws) on malformed input', () => {
    expect(loopBalanceCoversCharge('garbage', '1250')).toBe(false);
    expect(loopBalanceCoversCharge('12.5000000', 'garbage')).toBe(false);
  });
});
