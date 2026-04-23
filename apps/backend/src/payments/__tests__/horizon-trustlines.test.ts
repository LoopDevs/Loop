import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetTrustlineCacheForTests, getAccountTrustlines } from '../horizon-trustlines.js';

const fetchMock = vi.fn();

beforeEach(() => {
  __resetTrustlineCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAccountTrustlines', () => {
  it('extracts trustlines from Horizon /accounts balances', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        account_id: 'GUSER',
        balances: [
          { asset_type: 'native', balance: '5.0000000' },
          {
            asset_type: 'credit_alphanum12',
            asset_code: 'USDLOOP',
            asset_issuer: 'GUSD',
            balance: '12.5000000',
            limit: '922337203685.4775807',
          },
          {
            asset_type: 'credit_alphanum12',
            asset_code: 'GBPLOOP',
            asset_issuer: 'GGBP',
            balance: '0.0000000',
            limit: '1000.0000000',
          },
        ],
      }),
    } as Response);

    const snap = await getAccountTrustlines('GUSER');
    expect(snap.accountExists).toBe(true);
    expect(snap.trustlines.size).toBe(2); // native XLM row excluded
    const usd = snap.trustlines.get('USDLOOP::GUSD');
    expect(usd?.balanceStroops).toBe(125_000_000n);
    const gbp = snap.trustlines.get('GBPLOOP::GGBP');
    expect(gbp?.balanceStroops).toBe(0n);
    expect(gbp?.limitStroops).toBe(10_000_000_000n);
  });

  it('returns accountExists=false on Horizon 404 (unfunded account)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
    const snap = await getAccountTrustlines('GMISSING');
    expect(snap.accountExists).toBe(false);
    expect(snap.trustlines.size).toBe(0);
  });

  it('throws on non-404 non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    await expect(getAccountTrustlines('GOOPS')).rejects.toThrow(/Horizon 500/);
  });

  it('throws on schema drift', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'shape' }),
    } as Response);
    await expect(getAccountTrustlines('GBAD')).rejects.toThrow(/schema drift/);
  });

  it('caches for 30s per address', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account_id: 'GCACHE', balances: [] }),
    } as Response);
    await getAccountTrustlines('GCACHE');
    await getAccountTrustlines('GCACHE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not collide cache between different addresses', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account_id: 'GTEST', balances: [] }),
    } as Response);
    await getAccountTrustlines('GA');
    await getAccountTrustlines('GB');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
