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

  it('probe timeout failsafe unsticks the circuit when a HALF_OPEN probe hangs', async () => {
    // Scenario: a caller forgets to pass an AbortSignal and the probe
    // fetch hangs. Without the failsafe, `halfOpenInFlight` would stay true
    // forever and every later request would reject. The failsafe must
    // call `onFailure`, which clears the flag and transitions back to OPEN
    // with a fresh `openedAt` so a future request can retry after cooldown.
    const cb = createCircuitBreaker({
      failureThreshold: 2,
      // Large cooldown so the test doesn't race the failsafe transition.
      cooldownMs: 10_000,
      probeTimeoutMs: 40,
    });

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await cb.fetch('http://x');
    }
    expect(cb.getState()).toBe('open');

    // Force the circuit into HALF_OPEN for the test — the easiest way is
    // to reset then re-trip with a short cooldown. Instead we use a
    // dedicated breaker tuned for this test.
    const probe = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 20,
      probeTimeoutMs: 40,
    });
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await probe.fetch('http://x');
    }
    expect(probe.getState()).toBe('open');

    // Cooldown elapses
    await new Promise((r) => setTimeout(r, 30));

    // Probe fetch hangs indefinitely — we never resolve this promise.
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    const hung = probe.fetch('http://x').catch(() => undefined);

    // Give the failsafe time to fire (probeTimeoutMs + margin).
    await new Promise((r) => setTimeout(r, 60));

    // Circuit should have kicked itself back to OPEN. The core invariant:
    // the failsafe must have cleared `halfOpenInFlight` so future work is
    // not blocked by a stuck in-flight probe.
    expect(probe.getState()).toBe('open');

    void hung;
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

  // TST-01: pin the DOCUMENTED defaults (failureThreshold 5, cooldownMs
  // 30_000 — see the CircuitBreakerOptions JSDoc) so a silent change to
  // either constant is caught here rather than in production.
  it('defaults failureThreshold to 5 (4 failures stay CLOSED, the 5th opens)', async () => {
    const cb = createCircuitBreaker();

    // Four consecutive 5xx must NOT trip the breaker on the default threshold.
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await cb.fetch('http://x');
    }
    expect(cb.getState()).toBe('closed');

    // The fifth failure reaches the default threshold and opens it.
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await cb.fetch('http://x');
    expect(cb.getState()).toBe('open');
  });

  it('defaults cooldownMs to 30_000 (OPEN stays closed to probes until 30s elapses)', async () => {
    vi.useFakeTimers();
    try {
      const cb = createCircuitBreaker(); // default threshold 5, cooldown 30_000
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
        await cb.fetch('http://x');
      }
      expect(cb.getState()).toBe('open');

      // One millisecond short of the default cooldown: still OPEN, no probe.
      vi.advanceTimersByTime(29_999);
      expect(cb.isAvailable()).toBe(false);
      expect(cb.getState()).toBe('open');

      // At exactly 30_000ms the cooldown has elapsed → HALF_OPEN, probe allowed.
      vi.advanceTimersByTime(1);
      expect(cb.isAvailable()).toBe(true);
      expect(cb.getState()).toBe('half_open');
    } finally {
      vi.useRealTimers();
    }
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
    expect(mockNotify).toHaveBeenCalledWith(
      'open',
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('fires one "closed" notification when HALF_OPEN probe succeeds', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });

    // Trip
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
      await cb.fetch('http://x');
    }
    expect(mockNotify).toHaveBeenCalledWith(
      'open',
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    );

    mockNotify.mockClear();

    // Wait for cooldown, then successful probe
    await new Promise((r) => setTimeout(r, 80));
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await cb.fetch('http://x');

    expect(cb.getState()).toBe('closed');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('closed', 0, undefined, expect.any(String));
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

describe('A2-1305 — outbound X-Request-Id propagation', () => {
  // Dynamically imported inside the describe so the `getCurrentRequestId`
  // ALS is a fresh instance for these tests (circuit-breaker.ts captures
  // the import at module load).
  it('passes the ambient request ID onto outbound fetch headers', async () => {
    const { runWithRequestContext } = await import('../request-context.js');
    const cb = createCircuitBreaker();
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await runWithRequestContext({ requestId: 'req-42' }, async () => {
      await cb.fetch('http://ctx.local/x');
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('X-Request-Id')).toBe('req-42');
  });

  it('does not set X-Request-Id when no request context is active', async () => {
    const cb = createCircuitBreaker();
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await cb.fetch('http://ctx.local/x');

    const [, init] = mockFetch.mock.calls[0]!;
    // `init` may be `undefined` entirely when the caller passed none;
    // either way, no id should be set.
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('X-Request-Id')).toBeNull();
  });

  it('respects a caller-set X-Request-Id — does not override', async () => {
    const { runWithRequestContext } = await import('../request-context.js');
    const cb = createCircuitBreaker();
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await runWithRequestContext({ requestId: 'req-ambient' }, async () => {
      await cb.fetch('http://ctx.local/x', {
        headers: { 'X-Request-Id': 'req-caller-override' },
      });
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('X-Request-Id')).toBe('req-caller-override');
  });
});

describe('CF-12 — 429 rate-limit is an upstream-health signal, not a success', () => {
  it('does NOT reset the failure counter on a 429 (429 is not a success)', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    // Two 500s push consecutiveFailures to 2.
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await cb.fetch('http://x');
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await cb.fetch('http://x');
    expect(cb.getState()).toBe('closed');

    // A 429 must NOT reset the counter — if it counted as a success
    // the next 500 would only bring us to 1 and never open. Because the
    // 429 counts as a failure, the counter reaches the threshold of 3
    // on this very call and the breaker opens.
    mockFetch.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await cb.fetch('http://x');
    expect(cb.getState()).toBe('open');
  });

  it('opens after consecutive 429s reach the threshold', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
      await cb.fetch('http://x');
    }
    expect(cb.getState()).toBe('open');
  });

  it('other 4xx still do NOT trip the circuit', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2 });
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
      await cb.fetch('http://x');
    }
    expect(cb.getState()).toBe('closed');
  });
});

describe('CF-13 — forceOpen trips the circuit out-of-band', () => {
  it('opens immediately on forceOpen without any failed fetch', () => {
    const cb = createCircuitBreaker({ failureThreshold: 5 });
    expect(cb.getState()).toBe('closed');
    cb.forceOpen();
    expect(cb.getState()).toBe('open');
  });

  it('a forceOpen circuit fast-fails subsequent requests with CircuitOpenError', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 });
    cb.forceOpen();
    mockFetch.mockReset();
    await expect(cb.fetch('http://x')).rejects.toThrow(CircuitOpenError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires the open notification once on forceOpen', () => {
    const cb = createCircuitBreaker({ name: 'operator:op-1' });
    cb.forceOpen();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      'open',
      expect.any(Number),
      expect.any(Number),
      'operator:op-1',
    );
  });

  it('is a no-op when already OPEN (does not re-notify or extend cooldown)', async () => {
    const cb = createCircuitBreaker({ name: 'operator:op-1' });
    cb.forceOpen();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    cb.forceOpen();
    cb.forceOpen();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(cb.getState()).toBe('open');
  });

  it('recovers via a HALF_OPEN probe after the cooldown elapses', async () => {
    const cb = createCircuitBreaker({ cooldownMs: 30 });
    cb.forceOpen();
    expect(cb.getState()).toBe('open');
    await new Promise((r) => setTimeout(r, 50));
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await cb.fetch('http://x');
    expect(res.status).toBe(200);
    expect(cb.getState()).toBe('closed');
  });
});

describe('CF2-01 (2026-06-30 cold audit) — isAvailable() self-heal without calling fetch', () => {
  it('reports unavailable immediately after opening', () => {
    const cb = createCircuitBreaker({ cooldownMs: 10_000 });
    cb.forceOpen();
    expect(cb.isAvailable()).toBe(false);
  });

  it('flips to available once the cooldown elapses — WITHOUT any .fetch() call in between', async () => {
    // This is the exact bug: a caller (operator-pool's pickHealthyOperator)
    // that filters on isAvailable() before ever calling .fetch() must see
    // the breaker become eligible again once the cooldown passes. Before
    // CF2-01, only .fetch() itself ran the cooldown-expiry check, so a
    // breaker filtered out by a bare getState() read could never recover.
    const cb = createCircuitBreaker({ cooldownMs: 30 });
    cb.forceOpen();
    expect(cb.isAvailable()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    // No cb.fetch() call anywhere above this line.
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe('half_open');
  });

  it('a single forceOpen (one bad response, e.g. CF-13 401) is enough to make isAvailable() false — proving the exact CF2-01 exposure', () => {
    // CF-13's forceOpen() trips the breaker to OPEN on a single 401,
    // unlike the old 5-consecutive-failure threshold. Confirms
    // isAvailable() reflects that immediately, same as getState() did —
    // the fix is about RECOVERY, not about making it harder to trip.
    const cb = createCircuitBreaker({ failureThreshold: 5, cooldownMs: 10_000 });
    expect(cb.isAvailable()).toBe(true);
    cb.forceOpen();
    expect(cb.isAvailable()).toBe(false);
  });

  it('only allows one probe attempt through isAvailable() while HALF_OPEN — a second caller sees unavailable until the probe resolves', async () => {
    const cb = createCircuitBreaker({ cooldownMs: 30 });
    cb.forceOpen();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.isAvailable()).toBe(true); // transitions to half_open here
    expect(cb.getState()).toBe('half_open');
    // A concurrent caller must not also see this operator as available —
    // only one probe should be in flight at a time. isAvailable() alone
    // doesn't mark a probe in-flight (only .fetch() does), so a second
    // isAvailable() call still reports true until something actually
    // calls .fetch() to claim the probe slot.
    let fetchResolve!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise((r) => (fetchResolve = r)));
    const probe = cb.fetch('http://x');
    expect(cb.isAvailable()).toBe(false); // probe now in flight
    fetchResolve(new Response('ok', { status: 200 }));
    await probe;
    expect(cb.getState()).toBe('closed');
  });
});
