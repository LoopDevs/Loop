import { describe, it, expect, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { publicRumHandler } from '../rum.js';
import { metrics, __resetMetricsForTests } from '../../metrics.js';

function makeCtx(body: unknown): { c: Context; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const c = {
    req: {
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return body;
      },
    },
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (respBody: unknown, status?: number) =>
      new Response(JSON.stringify(respBody), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
  return { c, headers };
}

beforeEach(() => {
  __resetMetricsForTests();
});

describe('publicRumHandler (ADR 048)', () => {
  it('records a valid vital observation into /metrics and returns 200', async () => {
    const { c, headers } = makeCtx({ type: 'vital', name: 'LCP', value: 1800 });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(200);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(metrics.webVitals.LCP.count).toBe(1);
    expect(metrics.webVitals.LCP.sum).toBe(1800);
  });

  it('records a page-view marker into /metrics and returns 200', async () => {
    const { c } = makeCtx({ type: 'pageview' });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(200);
    expect(metrics.pageViewsTotal).toBe(1);
  });

  it('400s on an unknown vital name', async () => {
    const { c } = makeCtx({ type: 'vital', name: 'FID', value: 100 });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(metrics.webVitals.LCP.count).toBe(0);
  });

  it('400s on a negative value', async () => {
    const { c } = makeCtx({ type: 'vital', name: 'CLS', value: -0.1 });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
  });

  it('400s on an absurdly large value (bounded body)', async () => {
    const { c } = makeCtx({ type: 'vital', name: 'INP', value: 1e12 });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
  });

  it('400s on an unknown event type', async () => {
    const { c } = makeCtx({ type: 'click', target: 'button' });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
  });

  it('400s on unexpected extra fields (strict schema)', async () => {
    const { c } = makeCtx({ type: 'pageview', path: '/home' });
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
  });

  it('never 500s on malformed JSON — 400, not a crash', async () => {
    const { c } = makeCtx(undefined);
    const res = await publicRumHandler(c);
    expect(res.status).toBe(400);
  });

  it('vital + pageview events are independently counted across calls', async () => {
    await publicRumHandler(makeCtx({ type: 'vital', name: 'CLS', value: 0.05 }).c);
    await publicRumHandler(makeCtx({ type: 'vital', name: 'CLS', value: 0.2 }).c);
    await publicRumHandler(makeCtx({ type: 'pageview' }).c);
    expect(metrics.webVitals.CLS.count).toBe(2);
    expect(metrics.pageViewsTotal).toBe(1);
  });
});
