import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * payoutAsset helper mock — tests swap the configured pairs to
 * cover fully/partially/empty configured operator deployments, plus
 * the "throws" branch to exercise the never-500 fallback.
 */
const { assetsState } = vi.hoisted(() => ({
  assetsState: {
    pairs: [] as Array<{ code: string; issuer: string }>,
    throw: false,
  },
}));
vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => {
    if (assetsState.throw) throw new Error('env read exploded');
    return assetsState.pairs;
  },
}));

import { publicLoopAssetsHandler } from '../loop-assets.js';

function makeCtx(): { c: Context; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const c = {
    req: {},
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
  return { c, headers };
}

beforeEach(() => {
  assetsState.pairs = [];
  assetsState.throw = false;
});

describe('publicLoopAssetsHandler', () => {
  it('empty deployment — returns an empty assets list, not 500', async () => {
    const { c, headers } = makeCtx();
    const res = await publicLoopAssetsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: unknown[] };
    expect(body.assets).toEqual([]);
    expect(headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('happy path — surfaces every configured (code, issuer) pair', async () => {
    assetsState.pairs = [
      { code: 'USDLOOP', issuer: 'GAUSD1234567890' },
      { code: 'GBPLOOP', issuer: 'GAGBP1234567890' },
      { code: 'EURLOOP', issuer: 'GAEUR1234567890' },
    ];
    const { c } = makeCtx();
    const res = await publicLoopAssetsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ code: string; issuer: string }> };
    expect(body.assets).toEqual([
      { code: 'USDLOOP', issuer: 'GAUSD1234567890' },
      { code: 'GBPLOOP', issuer: 'GAGBP1234567890' },
      { code: 'EURLOOP', issuer: 'GAEUR1234567890' },
    ]);
  });

  it('partial deployment — only configured pairs are surfaced', async () => {
    // Only USDLOOP configured; the helper already filters to issuer-
    // present pairs. Handler passes through unchanged.
    assetsState.pairs = [{ code: 'USDLOOP', issuer: 'GAUSD1234567890' }];
    const { c } = makeCtx();
    const res = await publicLoopAssetsHandler(c);
    const body = (await res.json()) as { assets: Array<{ code: string }> };
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]?.code).toBe('USDLOOP');
  });

  it('never-500 — helper throw falls back to empty list with shorter cache', async () => {
    assetsState.throw = true;
    const { c, headers } = makeCtx();
    const res = await publicLoopAssetsHandler(c);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: unknown[] };
    expect(body.assets).toEqual([]);
    // Shorter cache on the fallback path so a fix is reflected faster
    // than the 5-minute happy-path TTL.
    expect(headers['Cache-Control']).toBe('public, max-age=60');
  });
});
