import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api-client', () => ({
  authenticatedRequest: vi.fn(),
}));

import {
  setHomeCurrency,
  getMe,
  getMyAccount,
  linkWallet,
  updateWallet,
  unlinkWallet,
  getCashbackHistory,
  getCashbackSummary,
  getCashbackByMerchant,
  getCashbackMonthly,
  getUserOrdersSummary,
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

describe('getMyAccount', () => {
  it('GETs /api/users/me/account', async () => {
    mockAuth.mockResolvedValue({ wallet: [], linkedWallets: [], payouts: [] });
    await getMyAccount();
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/account');
  });
});

describe('linkWallet', () => {
  it('POSTs the chain + address body', async () => {
    mockAuth.mockResolvedValue({ id: 'w-1' });
    await linkWallet({ chain: 'XLM', address: 'GABC123' });
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/wallets', {
      method: 'POST',
      body: { chain: 'XLM', address: 'GABC123' },
    });
  });
});

describe('updateWallet', () => {
  it('PUTs the autoPayout toggle to the url-encoded wallet id', async () => {
    mockAuth.mockResolvedValue({ id: 'w 1' });
    await updateWallet('w 1', { autoPayout: false });
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/wallets/w%201', {
      method: 'PUT',
      body: { autoPayout: false },
    });
  });
});

describe('unlinkWallet', () => {
  it('DELETEs the url-encoded wallet id', async () => {
    mockAuth.mockResolvedValue({ id: 'w-1', status: 'removed' });
    await unlinkWallet('w/1');
    expect(mockAuth).toHaveBeenCalledWith('/api/users/me/wallets/w%2F1', { method: 'DELETE' });
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
