import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiException } from '@loop/shared';

vi.mock('../api-client', () => ({
  authenticatedRequest: vi.fn(),
}));

import {
  setHomeCurrency,
  getMe,
  setStellarAddress,
  getCashbackHistory,
  getUserPendingPayouts,
  getUserPendingPayoutsSummary,
  getUserStellarTrustlines,
  getUserPayoutByOrder,
  getMyCredits,
  getCashbackSummary,
  getCashbackByMerchant,
  getCashbackMonthly,
  getUserOrdersSummary,
  getUserFlywheelStats,
  getUserPaymentMethodShare,
} from '../user';
import { authenticatedRequest } from '../api-client';

const mockAuth = vi.mocked(authenticatedRequest);

beforeEach(() => {
  mockAuth.mockReset();
});

/**
 * A2-1702 — `services/user.ts` is thin wrapper code around
 * `authenticatedRequest`. The risk is a silent path / body / query
 * shape drift, so tests check every fetcher's exact call to the
 * underlying client. Shapes come from `@loop/shared/users-me.ts`
 * (A2-1505) so the tests don't reproduce full response contracts —
 * `mockAuth.mockResolvedValue(...)` with a minimal object is enough
 * to drive the wrapper's return path.
 */

describe('setHomeCurrency', () => {
  it('POSTs /api/users/me/home-currency with { currency }', async () => {
    mockAuth.mockResolvedValue({});
    await setHomeCurrency('GBP');
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/home-currency', {
      method: 'POST',
      body: { currency: 'GBP' },
    });
  });
});

describe('getMe', () => {
  it('GETs /api/users/me', async () => {
    mockAuth.mockResolvedValue({});
    await getMe();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me');
  });
});

describe('setStellarAddress', () => {
  it('PUTs the address wrapped in { address }', async () => {
    mockAuth.mockResolvedValue({});
    await setStellarAddress('GABC123');
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/stellar-address', {
      method: 'PUT',
      body: { address: 'GABC123' },
    });
  });

  it('sends { address: null } when unlinking', async () => {
    mockAuth.mockResolvedValue({});
    await setStellarAddress(null);
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/stellar-address', {
      method: 'PUT',
      body: { address: null },
    });
  });
});

describe('getCashbackHistory', () => {
  it('omits the query string when no opts', async () => {
    mockAuth.mockResolvedValue({ items: [], nextBefore: null });
    await getCashbackHistory();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/cashback-history');
  });

  it('appends ?limit= and ?before= in URLSearchParams form', async () => {
    mockAuth.mockResolvedValue({ items: [], nextBefore: null });
    await getCashbackHistory({ limit: 25, before: '2026-04-23T00:00:00Z' });
    const [[path]] = mockAuth.mock.calls as [[string, unknown]];
    // Order from URLSearchParams: insertion order per the impl
    expect(path).toBe('/api/users/me/cashback-history?limit=25&before=2026-04-23T00%3A00%3A00Z');
  });

  it('sends only the provided param when one is omitted', async () => {
    mockAuth.mockResolvedValue({ items: [], nextBefore: null });
    await getCashbackHistory({ limit: 10 });
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/cashback-history?limit=10');
  });
});

describe('getUserPendingPayouts', () => {
  it('omits the query string when no opts', async () => {
    mockAuth.mockResolvedValue({ items: [], nextBefore: null });
    await getUserPendingPayouts();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/pending-payouts');
  });

  it('threads state / limit / before into the query string', async () => {
    mockAuth.mockResolvedValue({ items: [], nextBefore: null });
    await getUserPendingPayouts({
      state: 'pending',
      limit: 10,
      before: '2026-04-23T00:00:00Z',
    });
    const [[path]] = mockAuth.mock.calls as [[string, unknown]];
    expect(path).toBe(
      '/api/users/me/pending-payouts?state=pending&limit=10&before=2026-04-23T00%3A00%3A00Z',
    );
  });
});

describe('getUserPendingPayoutsSummary', () => {
  it('GETs the summary endpoint', async () => {
    mockAuth.mockResolvedValue({ rows: [] });
    await getUserPendingPayoutsSummary();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/pending-payouts/summary');
  });
});

describe('getUserStellarTrustlines', () => {
  it('GETs the trustlines endpoint', async () => {
    mockAuth.mockResolvedValue({ trustlines: [] });
    await getUserStellarTrustlines();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/stellar-trustlines');
  });
});

describe('getUserPayoutByOrder', () => {
  it('url-encodes the orderId in the path', async () => {
    mockAuth.mockResolvedValue({});
    await getUserPayoutByOrder('order with/special&chars');
    expect(mockAuth).toHaveBeenCalledWith(
      '/api/users/me/orders/order%20with%2Fspecial%26chars/payout',
    );
  });

  it('returns null on a 404 (no payout for this order)', async () => {
    mockAuth.mockRejectedValue(new ApiException(404, { code: 'NOT_FOUND', message: 'no payout' }));
    const out = await getUserPayoutByOrder('order-1');
    expect(out).toBeNull();
  });

  it('propagates non-404 errors', async () => {
    mockAuth.mockRejectedValue(new ApiException(500, { code: 'INTERNAL', message: 'boom' }));
    await expect(getUserPayoutByOrder('order-1')).rejects.toThrow(ApiException);
  });

  it('propagates a non-ApiException (network / timeout) error', async () => {
    mockAuth.mockRejectedValue(new Error('fetch aborted'));
    await expect(getUserPayoutByOrder('order-1')).rejects.toThrow(/fetch aborted/);
  });
});

describe('getMyCredits', () => {
  it('GETs /api/users/me/credits', async () => {
    mockAuth.mockResolvedValue({ balances: [] });
    await getMyCredits();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/credits');
  });
});

describe('getCashbackSummary', () => {
  it('GETs /api/users/me/cashback-summary', async () => {
    mockAuth.mockResolvedValue({
      totalCashbackMinor: '0',
      recycledCashbackMinor: '0',
      currency: 'USD',
    });
    await getCashbackSummary();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/cashback-summary');
  });
});

describe('getCashbackByMerchant', () => {
  it('omits the query string when no opts', async () => {
    mockAuth.mockResolvedValue({ merchants: [] });
    await getCashbackByMerchant();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/cashback-by-merchant');
  });

  it('threads since / limit into the query string', async () => {
    mockAuth.mockResolvedValue({ merchants: [] });
    await getCashbackByMerchant({ since: '2026-01-01', limit: 20 });
    expect(mockAuth).toHaveBeenCalledWith(
      '/api/users/me/cashback-by-merchant?since=2026-01-01&limit=20',
    );
  });
});

describe('getCashbackMonthly', () => {
  it('GETs /api/users/me/cashback-monthly', async () => {
    mockAuth.mockResolvedValue({ months: [] });
    await getCashbackMonthly();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/cashback-monthly');
  });
});

describe('getUserOrdersSummary', () => {
  it('GETs /api/users/me/orders/summary', async () => {
    mockAuth.mockResolvedValue({});
    await getUserOrdersSummary();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/orders/summary');
  });
});

describe('getUserFlywheelStats', () => {
  it('GETs /api/users/me/flywheel-stats', async () => {
    mockAuth.mockResolvedValue({
      currency: 'USD',
      recycledOrderCount: 0,
      recycledChargeMinor: '0',
      totalFulfilledCount: 0,
      totalFulfilledChargeMinor: '0',
    });
    await getUserFlywheelStats();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/flywheel-stats');
  });
});

describe('getUserPaymentMethodShare', () => {
  it('omits the query string when no state passed', async () => {
    mockAuth.mockResolvedValue({ buckets: [] });
    await getUserPaymentMethodShare();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/payment-method-share');
  });

  it('passes ?state= when provided', async () => {
    mockAuth.mockResolvedValue({ buckets: [] });
    await getUserPaymentMethodShare({ state: 'fulfilled' });
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/payment-method-share?state=fulfilled');
  });
});
