import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { getAssetBalance, __resetAssetBalanceCacheForTests } from '../horizon-asset-balance.js';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockHorizon(body: unknown, status = 200): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  __resetAssetBalanceCacheForTests();
  delete process.env['LOOP_STELLAR_HORIZON_URL'];
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  __resetAssetBalanceCacheForTests();
});

describe('getAssetBalance', () => {
  it('returns the account holder’s stroops for a matching asset code+issuer', async () => {
    fetchSpy = mockHorizon({
      account_id: 'GHOLDER',
      balances: [
        { asset_type: 'native', balance: '5.0000000' },
        {
          asset_type: 'credit_alphanum12',
          asset_code: 'USDLOOP',
          asset_issuer: 'GISSUER',
          balance: '12.3456700',
        },
      ],
    });
    const out = await getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER');
    expect(out).toBe(123_456_700n); // 12.34567 × 1e7
  });

  it('returns null when the account has no trustline to the requested asset', async () => {
    fetchSpy = mockHorizon({
      account_id: 'GHOLDER',
      balances: [{ asset_type: 'native', balance: '1.0000000' }],
    });
    const out = await getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER');
    expect(out).toBeNull();
  });

  it('returns null on 404 (unfunded account literally cannot hold any LOOP)', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('not found', { status: 404 }));
    const out = await getAssetBalance('GUNFUNDED', 'USDLOOP', 'GISSUER');
    expect(out).toBeNull();
  });

  it('throws on non-2xx (Horizon outage / 5xx)', async () => {
    fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('upstream', { status: 503 }));
    await expect(getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER')).rejects.toThrow(/Horizon 503/);
  });

  it('throws on schema drift (response missing balances array)', async () => {
    fetchSpy = mockHorizon({ account_id: 'GHOLDER' });
    await expect(getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER')).rejects.toThrow(/schema drift/);
  });

  it('caches per (account, code, issuer) for 30s — second call within the window does not refetch', async () => {
    fetchSpy = mockHorizon({
      account_id: 'GHOLDER',
      balances: [
        {
          asset_type: 'credit_alphanum12',
          asset_code: 'USDLOOP',
          asset_issuer: 'GISSUER',
          balance: '1.0000000',
        },
      ],
    });
    await getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER');
    await getAssetBalance('GHOLDER', 'USDLOOP', 'GISSUER');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('different (code, issuer) keys do NOT share the cache — each fetches once', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          account_id: 'GHOLDER',
          balances: [
            {
              asset_type: 'credit_alphanum12',
              asset_code: 'USDLOOP',
              asset_issuer: 'GA',
              balance: '1.0000000',
            },
            {
              asset_type: 'credit_alphanum12',
              asset_code: 'GBPLOOP',
              asset_issuer: 'GB',
              balance: '2.0000000',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await getAssetBalance('GHOLDER', 'USDLOOP', 'GA');
    await getAssetBalance('GHOLDER', 'GBPLOOP', 'GB');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honours LOOP_STELLAR_HORIZON_URL override', async () => {
    process.env['LOOP_STELLAR_HORIZON_URL'] = 'https://horizon-test.example';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return new Response(JSON.stringify({ account_id: 'GA', balances: [] }), { status: 200 });
    });
    await getAssetBalance('GACCOUNT', 'USDLOOP', 'GISSUER');
    expect(captured[0]!).toContain('https://horizon-test.example/accounts/');
  });
});
