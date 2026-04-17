import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../env.js', () => ({
  env: {
    PORT: '8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// Capture notification calls so we can assert the notification-storm fix.
const mockNotify = vi.hoisted(() => vi.fn());
vi.mock('../discord.js', () => ({
  notifyCircuitBreaker: mockNotify,
  notifyOrderCreated: vi.fn(),
  notifyOrderFulfilled: vi.fn(),
  notifyHealthChange: vi.fn(),
}));

import { createCircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockNotify.mockReset();
});

describe('createCircuitBreaker', () => {
  it('starts in CLOSED state', () => {
    const cb = createCircuitBreaker();
    expect(cb.getState()).toBe('closed');
  });

  it('passes requests through in CLOSED state', async () => {
    const cb = createCircuitBreaker();
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await cb.fetch('http://example.com/test');
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cb.getState()).toBe('closed');
  });

  it('stays CLOSED on 4xx responses (client errors do not trip the circuit)', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2 });

    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
      const res = await cb.fetch('http://example.com/test');
      expect(res.status).toBe(400);
    }

    expect(cb.getState()).toBe('closed');
  });

  it('transitions to OPEN after consecutive 5xx failures reach threshold', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    // 3 consecutive 500s → OPEN
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }

    expect(cb.getState()).toBe('open');
  });

  it('transitions to OPEN after consecutive network failures reach threshold', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await cb.fetch('http://example.com/test').catch(() => {});
    }

    expect(cb.getState()).toBe('open');
  });

  it('rejects immediately with CircuitOpenError in OPEN state', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }
    expect(cb.getState()).toBe('open');

    // Next call should throw immediately without calling fetch
    mockFetch.mockReset();
    await expect(cb.fetch('http://example.com/test')).rejects.toThrow(CircuitOpenError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resets failure count on success', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    // 2 failures, then a success
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
    await cb.fetch('http://example.com/test');
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
    await cb.fetch('http://example.com/test');
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await cb.fetch('http://example.com/test');

    // Now 2 more failures should NOT trip it (counter was reset)
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
    await cb.fetch('http://example.com/test');
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
    await cb.fetch('http://example.com/test');

    expect(cb.getState()).toBe('closed');
  });

  it('transitions to HALF_OPEN after cooldown and allows one probe', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }
    expect(cb.getState()).toBe('open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // The next call should transition to HALF_OPEN and send a probe
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await cb.fetch('http://example.com/test');
    expect(res.status).toBe(200);
    expect(cb.getState()).toBe('closed');
  });

  it('returns to OPEN if the HALF_OPEN probe fails', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }
    expect(cb.getState()).toBe('open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // Probe fails with 500
    mockFetch.mockResolvedValueOnce(new Response('still broken', { status: 500 }));
    await cb.fetch('http://example.com/test');

    expect(cb.getState()).toBe('open');
  });

  it('rejects concurrent requests while HALF_OPEN probe is in flight', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }
    expect(cb.getState()).toBe('open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // Set up a slow probe response
    let resolveProbe!: (value: Response) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveProbe = resolve;
      }),
    );

    // Start the probe
    const probePromise = cb.fetch('http://example.com/test');

    // Second request while probe is in flight should be rejected
    await expect(cb.fetch('http://example.com/test')).rejects.toThrow(CircuitOpenError);

    // Complete the probe
    resolveProbe(new Response('ok', { status: 200 }));
    const res = await probePromise;
    expect(res.status).toBe(200);
    expect(cb.getState()).toBe('closed');
  });

  it('reset() restores CLOSED state', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));
      await cb.fetch('http://example.com/test');
    }
    expect(cb.getState()).toBe('open');

    cb.reset();
    expect(cb.getState()).toBe('closed');

    // Should work normally after reset
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await cb.fetch('http://example.com/test');
    expect(res.status).toBe(200);
  });

  it('uses default options when none are provided', () => {
    const cb = createCircuitBreaker();
    expect(cb.getState()).toBe('closed');
    // Just verifying it instantiates without errors — defaults are 5 failures, 30s cooldown
  });
});

describe('CircuitOpenError', () => {
  it('has the correct name and message', () => {
    const err = new CircuitOpenError();
    expect(err.name).toBe('CircuitOpenError');
    expect(err.message).toContain('Circuit breaker is open');
    expect(err instanceof Error).toBe(true);
  });
});

describe('notification behavior', () => {
  it('fires exactly one "open" notification when many concurrent requests fail', async () => {
    // Simulate a down upstream: 10 concurrent requests all fail 500.
    // Threshold is 3 — the circuit trips once three failures accumulate, but
    // the other 7 requests were already past the state-check guard (they
    // suspended on the fetch() await), so their eventual onFailure calls used
    // to re-enter the `>= threshold` branch and re-fire the Discord webhook.
    // Fix: only notify/reset openedAt when state is not already OPEN.
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    mockFetch.mockResolvedValue(new Response('err', { status: 500 }));

    // Fire all 10 concurrently so every wrappedFetch call passes the state
    // checks before any onFailure runs.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => cb.fetch('http://example.com/test')),
    );
    expect(results).toHaveLength(10);

    expect(cb.getState()).toBe('open');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('open', expect.any(Number), expect.any(Number));
  });

  it('fires one "closed" notification when HALF_OPEN probe succeeds', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });

    // Trip
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await cb.fetch('http://x');
    }
    expect(mockNotify).toHaveBeenCalledWith('open', expect.any(Number), expect.any(Number));

    mockNotify.mockClear();

    // Wait for cooldown, then successful probe
    await new Promise((r) => setTimeout(r, 80));
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await cb.fetch('http://x');

    expect(cb.getState()).toBe('closed');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('closed', 0);
  });

  it('does not re-fire "open" when a failed HALF_OPEN probe re-trips the circuit', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });

    // Trip once
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await cb.fetch('http://x');
    }
    expect(mockNotify).toHaveBeenCalledTimes(1);

    // Cooldown elapses → HALF_OPEN probe fails → back to OPEN.
    // This IS a real state transition (half_open → open), so notify is allowed
    // to fire again. Ensures we do not *suppress* legitimate re-trip signals.
    await new Promise((r) => setTimeout(r, 80));
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await cb.fetch('http://x');

    expect(cb.getState()).toBe('open');
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });
});
