import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetCirculationCacheForTests,
  amountToStroops,
  getLoopAssetCirculation,
} from '../horizon-circulation.js';

const fetchMock = vi.fn();

beforeEach(() => {
  __resetCirculationCacheForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('amountToStroops', () => {
  it('converts whole-unit strings', () => {
    expect(amountToStroops('0')).toBe(0n);
    expect(amountToStroops('1')).toBe(10_000_000n);
    expect(amountToStroops('42')).toBe(420_000_000n);
  });

  it('pads fractional digits to 7 decimals', () => {
    expect(amountToStroops('0.1')).toBe(1_000_000n);
    expect(amountToStroops('1.5')).toBe(15_000_000n);
    expect(amountToStroops('1234.567')).toBe(12_345_670_000n);
  });

  it('accepts the full 7-decimal form', () => {
    expect(amountToStroops('1.2345678')).toBe(12_345_678n);
  });

  it('rejects > 7 fractional digits + non-numeric input', () => {
    expect(() => amountToStroops('1.12345678')).toThrow();
    expect(() => amountToStroops('nope')).toThrow();
    expect(() => amountToStroops('')).toThrow();
  });

  it('handles negative amounts (defensive — Horizon never emits negative but be strict)', () => {
    expect(amountToStroops('-1.5')).toBe(-15_000_000n);
  });
});

describe('getLoopAssetCirculation', () => {
  it('returns stroops parsed from Horizon records[0].amount', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              asset_code: 'USDLOOP',
              asset_issuer: 'GABC',
              amount: '1234.5670000',
            },
          ],
        },
      }),
    } as Response);

    const snap = await getLoopAssetCirculation('USDLOOP', 'GABC');
    expect(snap.stroops).toBe(12_345_670_000n);
    expect(snap.assetCode).toBe('USDLOOP');
    expect(snap.issuer).toBe('GABC');
  });

  it('returns 0n stroops when Horizon returns no records (never-issued asset)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    } as Response);

    const snap = await getLoopAssetCirculation('GBPLOOP', 'GDEF');
    expect(snap.stroops).toBe(0n);
  });

  it('caches for 30s on the (code, issuer) key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        _embedded: { records: [{ asset_code: 'USDLOOP', asset_issuer: 'GABC', amount: '1' }] },
      }),
    } as Response);

    await getLoopAssetCirculation('USDLOOP', 'GABC');
    await getLoopAssetCirculation('USDLOOP', 'GABC');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache on (code, issuer) key change', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        _embedded: { records: [{ asset_code: 'USDLOOP', asset_issuer: 'GABC', amount: '1' }] },
      }),
    } as Response);

    await getLoopAssetCirculation('USDLOOP', 'GABC');
    await getLoopAssetCirculation('USDLOOP', 'GDIFFERENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    await expect(getLoopAssetCirculation('USDLOOP', 'GABC')).rejects.toThrow(/Horizon 500/);
  });

  it('throws on schema drift (missing _embedded.records)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    } as Response);
    await expect(getLoopAssetCirculation('USDLOOP', 'GABC')).rejects.toThrow(/schema drift/);
  });
});
