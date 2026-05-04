import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Array<{ currency: string; total: string }>,
  },
}));

vi.mock('../../db/client.js', () => {
  // Drizzle chain: select().from().groupBy() is awaited and returns rows.
  // We make the chain thenable so awaiting it yields state.rows.
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['groupBy'] = vi.fn(() => chain);
  (chain as { then: (resolve: (v: unknown) => void) => void }).then = (
    resolve: (v: unknown) => void,
  ) => resolve(state.rows);
  return { db: chain };
});

vi.mock('../../db/schema.js', () => ({
  userCredits: { currency: 'currency', balanceMinor: 'balance_minor' },
}));

import { computeInterestForecast } from '../interest-forecast.js';

beforeEach(() => {
  state.rows = [];
});

describe('computeInterestForecast', () => {
  it('returns zero rows for every home currency when the ledger is empty', async () => {
    state.rows = [];
    const out = await computeInterestForecast({ apyBasisPoints: 400 });
    expect(out.apyBasisPoints).toBe(400);
    expect(out.forecastDays).toBe(35);
    expect(out.perCurrency).toHaveLength(3);
    for (const row of out.perCurrency) {
      expect(row.cohortBalanceMinor).toBe(0n);
      expect(row.dailyInterestMinor).toBe(0n);
      expect(row.forecastInterestMinor).toBe(0n);
    }
  });

  it('computes daily interest as floor(balance × bps / (10_000 × 365)) per currency', async () => {
    // 4% APY, $10_000 cohort: daily = 1_000_000 × 400 / (10_000 × 365) = 109.5… → floor 109.
    state.rows = [{ currency: 'USD', total: '1000000' }];
    const out = await computeInterestForecast({ apyBasisPoints: 400, forecastDays: 35 });
    const usd = out.perCurrency.find((r) => r.currency === 'USD');
    expect(usd?.cohortBalanceMinor).toBe(1_000_000n);
    expect(usd?.dailyInterestMinor).toBe(109n);
    expect(usd?.forecastInterestMinor).toBe(109n * 35n);
    expect(usd?.assetCode).toBe('USDLOOP');
  });

  it('maps each home currency to its LOOP asset code', async () => {
    state.rows = [
      { currency: 'USD', total: '0' },
      { currency: 'GBP', total: '0' },
      { currency: 'EUR', total: '0' },
    ];
    const out = await computeInterestForecast({ apyBasisPoints: 350 });
    const codes = Object.fromEntries(out.perCurrency.map((r) => [r.currency, r.assetCode]));
    expect(codes).toEqual({ USD: 'USDLOOP', GBP: 'GBPLOOP', EUR: 'EURLOOP' });
  });

  it('honours forecastDays override', async () => {
    state.rows = [{ currency: 'GBP', total: '500000' }];
    const out = await computeInterestForecast({ apyBasisPoints: 400, forecastDays: 7 });
    expect(out.forecastDays).toBe(7);
    const gbp = out.perCurrency.find((r) => r.currency === 'GBP')!;
    expect(gbp.forecastInterestMinor).toBe(gbp.dailyInterestMinor * 7n);
  });

  it('returns zero daily interest at apyBasisPoints=0 even with cohort balance', async () => {
    state.rows = [{ currency: 'USD', total: '1000000' }];
    const out = await computeInterestForecast({ apyBasisPoints: 0 });
    for (const row of out.perCurrency) {
      expect(row.dailyInterestMinor).toBe(0n);
      expect(row.forecastInterestMinor).toBe(0n);
    }
  });

  it('ignores currencies outside the home-currency union', async () => {
    state.rows = [
      { currency: 'USD', total: '1000' },
      { currency: 'JPY', total: '99999' },
    ];
    const out = await computeInterestForecast({ apyBasisPoints: 400 });
    expect(out.perCurrency.find((r) => r.currency === 'USD')!.cohortBalanceMinor).toBe(1000n);
    // JPY is not in HOME_CURRENCIES, so it's filtered out — no row, no surprise total.
    expect(out.perCurrency).toHaveLength(3);
  });
});
