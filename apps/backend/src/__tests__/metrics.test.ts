import { describe, it, expect, beforeEach } from 'vitest';
import {
  metrics,
  recordRequestDuration,
  incrementRequest,
  REQUEST_DURATION_BUCKETS_SECONDS,
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
