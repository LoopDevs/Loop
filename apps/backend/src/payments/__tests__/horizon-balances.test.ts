import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getAccountBalances, __resetBalanceCacheForTests } from '../horizon-balances.js';

const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGV';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubHorizon(body: unknown, status = 200): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  __resetBalanceCacheForTests();
  delete process.env['LOOP_STELLAR_HORIZON_URL'];
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  __resetBalanceCacheForTests();
  delete process.env['LOOP_STELLAR_HORIZON_URL'];
});

describe('getAccountBalances', () => {
  it('parses XLM + USDC from Horizon /accounts response', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [
        { asset_type: 'native', balance: '123.4567890' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          balance: '500.0000000',
        },
      ],
    });
    const snap = await getAccountBalances(ACCOUNT, USDC_ISSUER);
    // 123.4567890 = 123 * 1e7 + 4567890 = 1_234_567_890 stroops
    expect(snap.xlmStroops).toBe(1_234_567_890n);
    // 500 USDC = 5_000_000_000 stroops
    expect(snap.usdcStroops).toBe(5_000_000_000n);
  });

  it('returns usdcStroops null when account has no USDC trustline', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    });
    const snap = await getAccountBalances(ACCOUNT, USDC_ISSUER);
    expect(snap.xlmStroops).toBe(100_000_000n);
    expect(snap.usdcStroops).toBeNull();
  });

  it('rejects USDC from a different issuer when usdcIssuer is pinned', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GIMPOSTER',
          balance: '999.0000000',
        },
      ],
    });
    const snap = await getAccountBalances(ACCOUNT, USDC_ISSUER);
    expect(snap.usdcStroops).toBeNull();
  });

  it('accepts USDC from any issuer when usdcIssuer is null (MVP leniency)', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GANY',
          balance: '42.0000000',
        },
      ],
    });
    const snap = await getAccountBalances(ACCOUNT, null);
    expect(snap.usdcStroops).toBe(420_000_000n);
  });

  it('treats a 404 as an unfunded account (both balances null)', async () => {
    fetchSpy = stubHorizon({ status: 404 }, 404);
    const snap = await getAccountBalances(ACCOUNT, USDC_ISSUER);
    expect(snap.xlmStroops).toBeNull();
    expect(snap.usdcStroops).toBeNull();
  });

  it('throws on non-2xx non-404', async () => {
    fetchSpy = stubHorizon({ err: 'down' }, 503);
    await expect(getAccountBalances(ACCOUNT, USDC_ISSUER)).rejects.toThrow(/Horizon 503/);
  });

  it('throws on schema drift', async () => {
    fetchSpy = stubHorizon({ not: 'an account' });
    await expect(getAccountBalances(ACCOUNT, USDC_ISSUER)).rejects.toThrow(/schema drift/);
  });

  it('caches across calls within the TTL window', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    });
    await getAccountBalances(ACCOUNT, USDC_ISSUER);
    await getAccountBalances(ACCOUNT, USDC_ISSUER);
    await getAccountBalances(ACCOUNT, USDC_ISSUER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the usdcIssuer key changes (no cross-issuer cache bleed)', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          balance: '1.0000000',
        },
      ],
    });
    await getAccountBalances(ACCOUNT, USDC_ISSUER);
    await getAccountBalances(ACCOUNT, 'GOTHER_ISSUER');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honours LOOP_STELLAR_HORIZON_URL override', async () => {
    process.env['LOOP_STELLAR_HORIZON_URL'] = 'https://horizon.example';
    const captured: string[] = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      captured.push(String(url));
      return new Response(
        JSON.stringify({
          account_id: ACCOUNT,
          balances: [],
        }),
        { status: 200 },
      );
    });
    await getAccountBalances(ACCOUNT, USDC_ISSUER);
    expect(captured[0]).toContain('https://horizon.example/accounts/');
  });

  it('skips malformed balance entries rather than throwing', async () => {
    fetchSpy = stubHorizon({
      account_id: ACCOUNT,
      balances: [
        { asset_type: 'native', balance: 'not-a-number' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          balance: '5.0000000',
        },
      ],
    });
    const snap = await getAccountBalances(ACCOUNT, USDC_ISSUER);
    // Malformed XLM → null; well-formed USDC → parsed.
    expect(snap.xlmStroops).toBeNull();
    expect(snap.usdcStroops).toBe(50_000_000n);
  });
});
