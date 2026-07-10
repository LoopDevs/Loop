import { describe, it, expect, beforeEach } from 'vitest';
import {
  metrics,
  recordRequestDuration,
  incrementRequest,
  recordWebVital,
  incrementPageView,
  REQUEST_DURATION_BUCKETS_SECONDS,
  WEB_VITAL_BUCKETS,
  WEB_VITAL_NAMES,
  __resetMetricsForTests,
} from '../metrics.js';

beforeEach(() => {
  __resetMetricsForTests();
});

describe('recordRequestDuration (A4-048)', () => {
  it('first observation creates the histogram and increments the matching buckets', () => {
    recordRequestDuration('GET', '/api/clusters', 0.07);
    const hist = metrics.requestDurationHistograms.get('GET\x1f/api/clusters');
    expect(hist).toBeDefined();
    expect(hist!.count).toBe(1);
    expect(hist!.sumSeconds).toBe(0.07);
    // 0.07s falls into le=0.1 (the first bucket whose upper bound is
    // ≥ 0.07). Cumulative buckets ≥ that index also increment.
    const i100ms = REQUEST_DURATION_BUCKETS_SECONDS.indexOf(0.1);
    expect(hist!.buckets[i100ms]).toBe(1);
    expect(hist!.buckets[i100ms + 1]).toBe(1); // 0.25
    // Buckets below 0.07 — i.e. 0.005 / 0.01 / 0.025 / 0.05 — must
    // remain zero. A common bug class is "all buckets increment on
    // every observation", which makes p50 read as the smallest bucket.
    for (let i = 0; i < i100ms; i++) {
      expect(hist!.buckets[i]).toBe(0);
    }
  });

  it('multiple observations accumulate count + sum + cumulative buckets', () => {
    recordRequestDuration('POST', '/api/orders', 0.005);
    recordRequestDuration('POST', '/api/orders', 0.5);
    recordRequestDuration('POST', '/api/orders', 1.5);
    const hist = metrics.requestDurationHistograms.get('POST\x1f/api/orders')!;
    expect(hist.count).toBe(3);
    expect(hist.sumSeconds).toBeCloseTo(2.005);
    // The le=2.5 bucket should hold all three observations.
    const i2500ms = REQUEST_DURATION_BUCKETS_SECONDS.indexOf(2.5);
    expect(hist.buckets[i2500ms]).toBe(3);
    // The le=0.005 bucket holds only the first.
    const i5ms = REQUEST_DURATION_BUCKETS_SECONDS.indexOf(0.005);
    expect(hist.buckets[i5ms]).toBe(1);
  });

  it('clamps non-finite / negative durations to 0 without corrupting buckets', () => {
    recordRequestDuration('GET', '/api/health', -1);
    recordRequestDuration('GET', '/api/health', Number.NaN);
    const hist = metrics.requestDurationHistograms.get('GET\x1f/api/health')!;
    expect(hist.count).toBe(2);
    expect(hist.sumSeconds).toBe(0);
    // 0s falls into every bucket (every `le` is ≥ 0).
    for (const v of hist.buckets) expect(v).toBe(2);
  });

  it('does not collide histograms with the request counter (different keyspaces)', () => {
    recordRequestDuration('GET', '/api/clusters', 0.05);
    incrementRequest('GET', '/api/clusters', 200);
    expect(metrics.requestDurationHistograms.size).toBe(1);
    expect(metrics.requestsTotal.size).toBe(1);
  });
});

describe('recordWebVital / incrementPageView (ADR 048)', () => {
  it('starts with an empty, fully-populated histogram per vital', () => {
    for (const name of WEB_VITAL_NAMES) {
      const hist = metrics.webVitals[name];
      expect(hist.count).toBe(0);
      expect(hist.sum).toBe(0);
      expect(hist.buckets).toEqual(new Array(WEB_VITAL_BUCKETS[name].length).fill(0));
    }
  });

  it('records an LCP observation into the correct cumulative buckets', () => {
    recordWebVital('LCP', 2200);
    const hist = metrics.webVitals.LCP;
    expect(hist.count).toBe(1);
    expect(hist.sum).toBe(2200);
    // 2200ms falls into le=2500 (first bound ≥ 2200) and every bound above it.
    const bounds = WEB_VITAL_BUCKETS.LCP;
    const i2500 = bounds.indexOf(2500);
    expect(hist.buckets[i2500]).toBe(1);
    expect(hist.buckets[bounds.length - 1]).toBe(1); // largest bound, still ≥ 2200
    for (let i = 0; i < i2500; i++) {
      expect(hist.buckets[i]).toBe(0);
    }
  });

  it('records a CLS observation using CLS-specific (unitless) buckets', () => {
    recordWebVital('CLS', 0.12);
    const hist = metrics.webVitals.CLS;
    expect(hist.count).toBe(1);
    expect(hist.sum).toBe(0.12);
    const bounds = WEB_VITAL_BUCKETS.CLS;
    const i015 = bounds.indexOf(0.15);
    expect(hist.buckets[i015]).toBe(1);
    // 0.1 bound is below 0.12, must stay 0.
    const i01 = bounds.indexOf(0.1);
    expect(hist.buckets[i01]).toBe(0);
  });

  it('clamps non-finite / negative values to 0 without corrupting buckets', () => {
    recordWebVital('INP', -50);
    recordWebVital('INP', Number.NaN);
    const hist = metrics.webVitals.INP;
    expect(hist.count).toBe(2);
    expect(hist.sum).toBe(0);
    for (const v of hist.buckets) expect(v).toBe(2);
  });

  it('vitals accumulate independently per name', () => {
    recordWebVital('FCP', 1000);
    recordWebVital('TTFB', 300);
    expect(metrics.webVitals.FCP.count).toBe(1);
    expect(metrics.webVitals.TTFB.count).toBe(1);
    expect(metrics.webVitals.LCP.count).toBe(0);
  });

  it('incrementPageView is a plain counter', () => {
    expect(metrics.pageViewsTotal).toBe(0);
    incrementPageView();
    incrementPageView();
    expect(metrics.pageViewsTotal).toBe(2);
  });
});
