import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as CircuitBreakerModule from '../../circuit-breaker.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// The pool fires Discord alerts on exhaustion (pool down) and on a
// 401-expired operator credential (CF-13). Mock the module so tests
// assert on the spies without actually reaching fetch(). Keeping the
// mock here (not in a separate file) keeps the test-scope narrow.
const { mockNotifyExhausted, mockNotifyCredentialExpired } = vi.hoisted(() => ({
  mockNotifyExhausted: vi.fn(),
  mockNotifyCredentialExpired: vi.fn(),
}));
vi.mock('../../discord.js', () => ({
  notifyOperatorPoolExhausted: mockNotifyExhausted,
  notifyOperatorCredentialExpired: mockNotifyCredentialExpired,
}));

/**
 * The breaker mock lets tests force "every operator is open" without
 * spamming fetch to trip real breakers. Default factory returns a
 * closed breaker that passes fetches through; tests that need
 * exhaustion flip `breakerFactoryState.forceOpen = true` BEFORE
 * the pool inits.
 *
 * CF-13: each created breaker also tracks its OWN open state so a test
 * can `forceOpen()` a single operator (via the real `operatorFetch`
 * 401 path) and have only that operator pulled from rotation, while
 * the global `forceOpen` flag still forces ALL operators open for the
 * exhaustion tests.
 */
const { breakerFactoryState } = vi.hoisted(() => ({
  breakerFactoryState: { forceOpen: false },
}));
vi.mock('../../circuit-breaker.js', async (importActual) => {
  const actual = (await importActual()) as typeof CircuitBreakerModule;
  return {
    ...actual,
    createCircuitBreaker: () => {
      let selfForcedOpen = false;
      const isOpen = (): boolean => breakerFactoryState.forceOpen || selfForcedOpen;
      return {
        // Returning 'open' short-circuits pickHealthyOperator — it skips
        // every operator and returns null, tripping the exhausted path.
        getState: () => (isOpen() ? 'open' : 'closed'),
        getStats: () => ({
          state: isOpen() ? 'open' : 'closed',
          consecutiveFailures: 0,
          openedAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
        }),
        fetch: (url: string | URL, init?: RequestInit) => fetch(url, init),
        reset: () => {
          selfForcedOpen = false;
        },
        forceOpen: () => {
          selfForcedOpen = true;
        },
      };
    },
    CircuitOpenError: actual.CircuitOpenError,
  };
});

import {
  operatorFetch,
  operatorPoolSize,
  getOperatorHealth,
  __resetOperatorPoolForTests,
  __resetPoolExhaustedAlertForTests,
  OperatorPoolUnavailableError,
  OperatorRateLimitedError,
  parseRetryAfterMs,
} from '../operator-pool.js';

// The pool snapshots env at first access; resetting the module state
// between tests makes the suite order-independent.
beforeEach(() => {
  __resetOperatorPoolForTests();
  __resetPoolExhaustedAlertForTests();
  mockNotifyExhausted.mockReset();
  mockNotifyCredentialExpired.mockReset();
  breakerFactoryState.forceOpen = false;
  delete process.env['CTX_OPERATOR_POOL'];
});

afterEach(() => {
  __resetOperatorPoolForTests();
  __resetPoolExhaustedAlertForTests();
  delete process.env['CTX_OPERATOR_POOL'];
});

function validPool(): void {
  process.env['CTX_OPERATOR_POOL'] = JSON.stringify([
    { id: 'primary', bearer: 'bearer-1' },
    { id: 'backup-1', bearer: 'bearer-2' },
  ]);
}

describe('operator pool — configuration', () => {
  it('reports size 0 when CTX_OPERATOR_POOL is unset', () => {
    expect(operatorPoolSize()).toBe(0);
  });

  it('parses a well-formed JSON array of {id, bearer}', () => {
    validPool();
    expect(operatorPoolSize()).toBe(2);
    const health = getOperatorHealth();
    expect(health.map((h) => h.id)).toEqual(['primary', 'backup-1']);
    expect(health.every((h) => h.state === 'closed')).toBe(true);
  });

  it('throws on invalid JSON', () => {
    process.env['CTX_OPERATOR_POOL'] = '{not json';
    expect(() => operatorPoolSize()).toThrow(/not valid JSON/);
  });

  it('throws on a JSON value that does not match the schema', () => {
    process.env['CTX_OPERATOR_POOL'] = JSON.stringify([{ id: '' }]);
    expect(() => operatorPoolSize()).toThrow(/schema validation/);
  });

  it('throws on an empty array (min: 1 operator)', () => {
    process.env['CTX_OPERATOR_POOL'] = '[]';
    expect(() => operatorPoolSize()).toThrow(/schema validation/);
  });

  // A2-573: the `initialised` flag must NOT flip to true until a parse
  // succeeds. Previously, the first malformed-env access set the flag
  // up-front, so a follow-up call after ops corrected the env silently
  // used the stale (empty) pool until a process restart.
  it('A2-573: retries parsing on subsequent calls after a malformed env is corrected', () => {
    process.env['CTX_OPERATOR_POOL'] = '{not json';
    expect(() => operatorPoolSize()).toThrow(/not valid JSON/);
    validPool();
    expect(operatorPoolSize()).toBe(2);
  });

  // A2-573 companion: the inert-env branch should still latch to
  // avoid re-logging "inert" on every call — the retry behaviour is
  // specific to recoverable errors (JSON parse / schema), not to the
  // deliberately-unset case.
  it('A2-573: inert-env branch still latches so we do not re-enter on every call', () => {
    expect(operatorPoolSize()).toBe(0);
    // Flip env after latch — the pool stays inert because the
    // unset-env path is sticky.
    validPool();
    expect(operatorPoolSize()).toBe(0);
  });
});

describe('operatorFetch', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    validPool();
    // The pool lazy-inits on first access; force it so we can
    // spy on fetch consistently.
    operatorPoolSize();
  });

  afterEach(() => {
    fetchMock?.mockRestore();
  });

  it('throws OperatorPoolUnavailableError when the pool is unconfigured', async () => {
    __resetOperatorPoolForTests();
    delete process.env['CTX_OPERATOR_POOL'];
    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );
  });

  it('injects Authorization: Bearer <operator> + the operator clientId on the outgoing request', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    });
    await operatorFetch('https://example.local/orders', {
      method: 'POST',
      // Caller-supplied X-Client-Id is overridden — operator's
      // own clientId (default 'loopweb') is the only safe choice
      // because CTX 401s on token-vs-header clientId mismatch.
      headers: { 'X-Client-Id': 'something-else' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(captured).toHaveLength(1);
    const h = new Headers(captured[0]!.init?.headers);
    expect(h.get('Authorization')).toMatch(/^Bearer bearer-[12]$/);
    expect(h.get('X-Client-Id')).toBe('loopweb');
    expect(captured[0]!.init?.method).toBe('POST');
  });

  it('honours per-operator clientId override in CTX_OPERATOR_POOL', async () => {
    delete process.env['CTX_OPERATOR_POOL'];
    process.env['CTX_OPERATOR_POOL'] = JSON.stringify([
      { id: 'ios-op', bearer: 'bearer-ios', clientId: 'loopios' },
    ]);
    __resetOperatorPoolForTests();
    const captured: Array<RequestInit | undefined> = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      captured.push(init);
      return new Response('{}', { status: 200 });
    });
    await operatorFetch('https://example.local/x');
    expect(new Headers(captured[0]?.headers).get('X-Client-Id')).toBe('loopios');
  });

  it('rotates operators across calls (round-robin)', async () => {
    const bearers: string[] = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const h = new Headers(init?.headers);
      bearers.push(h.get('Authorization') ?? '');
      return new Response('{}', { status: 200 });
    });
    await operatorFetch('https://example.local/x');
    await operatorFetch('https://example.local/x');
    await operatorFetch('https://example.local/x');
    // With 2 operators the sequence is b1, b2, b1.
    expect(bearers).toEqual(['Bearer bearer-1', 'Bearer bearer-2', 'Bearer bearer-1']);
  });

  it('returns the fetch response verbatim on success (no body munging)', async () => {
    fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('hello', { status: 201 }));
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('hello');
  });

  // A2-572: a persistent network error across both operators does still
  // surface to the caller — retry exhausted, not retry skipped.
  it('A2-572: throws the last error when every operator rejects the fetch', async () => {
    const err = new Error('connection reset');
    fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(err);
    await expect(operatorFetch('https://example.local/x')).rejects.toBe(err);
    // Two attempts — one per operator in the 2-entry pool.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('A2-572: retries against the fallback operator when the first fetch errors', async () => {
    const bearers: string[] = [];
    let call = 0;
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const h = new Headers(init?.headers);
      bearers.push(h.get('Authorization') ?? '');
      call++;
      if (call === 1) throw new Error('connection reset');
      return new Response('ok', { status: 200 });
    });
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(200);
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
  });

  it('A2-572: retries against the fallback operator when the first returns 5xx', async () => {
    const bearers: string[] = [];
    let call = 0;
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const h = new Headers(init?.headers);
      bearers.push(h.get('Authorization') ?? '');
      call++;
      if (call === 1) return new Response('upstream boom', { status: 503 });
      return new Response('ok', { status: 200 });
    });
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(200);
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
  });

  it('A2-572: surfaces the last 5xx when every operator returns 5xx', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('fleetwide outage', { status: 500 }));
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('A2-572: does NOT retry on 4xx — client errors propagate verbatim', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('A2-1510: applies a default 30s timeout signal when the caller supplies none', async () => {
    const captured: Array<RequestInit | undefined> = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      captured.push(init);
      return new Response('{}', { status: 200 });
    });
    await operatorFetch('https://example.local/x');
    expect(captured).toHaveLength(1);
    // Fetch init should have a signal present — the default timeout
    // we inject. We don't assert the exact ms (timer may drift) — the
    // contract is "not undefined".
    expect(captured[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('A2-1510: respects a caller-provided signal verbatim (no double timeout)', async () => {
    const captured: Array<RequestInit | undefined> = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      captured.push(init);
      return new Response('{}', { status: 200 });
    });
    const callerController = new AbortController();
    await operatorFetch('https://example.local/x', { signal: callerController.signal });
    expect(captured[0]?.signal).toBe(callerController.signal);
  });

  // ── CF-12: 429 handling ────────────────────────────────────────────
  it('CF-12: fails over to the next operator on a 429', async () => {
    const bearers: string[] = [];
    let call = 0;
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bearers.push(new Headers(init?.headers).get('Authorization') ?? '');
      call++;
      if (call === 1) return new Response('slow down', { status: 429 });
      return new Response('ok', { status: 200 });
    });
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(200);
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
  });

  it('CF-12: throws OperatorRateLimitedError (not a 429 response) when every operator is rate-limited', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
      );
    const err = await operatorFetch('https://example.local/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperatorRateLimitedError);
    // Retry-After parsed from the last 429 (7s → 7000ms).
    expect((err as OperatorRateLimitedError).retryAfterMs).toBe(7000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CF-12: a 429 storm does NOT fire the pool-exhausted page (back-pressure, not outage)', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('slow down', { status: 429 }));
    await operatorFetch('https://example.local/x').catch(() => {});
    expect(mockNotifyExhausted).not.toHaveBeenCalled();
  });

  it('CF-12: rate-limited error carries null retryAfterMs when CTX sends no usable header', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('slow down', { status: 429 }));
    const err = await operatorFetch('https://example.local/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperatorRateLimitedError);
    expect((err as OperatorRateLimitedError).retryAfterMs).toBeNull();
  });

  // ── CF-13: expired operator bearer (401) ───────────────────────────
  it('CF-13: marks the 401 operator unhealthy, fails over, and serves from a healthy sibling', async () => {
    const bearers: string[] = [];
    let call = 0;
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bearers.push(new Headers(init?.headers).get('Authorization') ?? '');
      call++;
      if (call === 1) return new Response('token invalid', { status: 401 });
      return new Response('ok', { status: 200 });
    });
    const res = await operatorFetch('https://example.local/x');
    expect(res.status).toBe(200);
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
    // The 401'd operator was forced OPEN, so the health snapshot shows it.
    const states = getOperatorHealth().map((h) => h.state);
    expect(states.filter((s) => s === 'open')).toHaveLength(1);
  });

  it('CF-13: alerts via notifyOperatorCredentialExpired on a 401', async () => {
    let call = 0;
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return new Response('token invalid', { status: 401 });
      return new Response('ok', { status: 200 });
    });
    await operatorFetch('https://example.local/x');
    expect(mockNotifyCredentialExpired).toHaveBeenCalledTimes(1);
    const [args] = mockNotifyCredentialExpired.mock.calls[0] as [
      { operatorId: string; poolSize: number; failedOver: boolean },
    ];
    expect(args.poolSize).toBe(2);
    // A sibling was available, so failover was possible.
    expect(args.failedOver).toBe(true);
  });

  it('CF-13: throws OperatorPoolUnavailableError (transient → defer) when every operator 401s', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('token invalid', { status: 401 }));
    const err = await operatorFetch('https://example.local/x').catch((e: unknown) => e);
    // Transient pool error so the procurement tick defers — NOT a 401
    // response the caller would treat as a hard order failure.
    expect(err).toBeInstanceOf(OperatorPoolUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both operators 401'd — both forced OPEN.
    expect(getOperatorHealth().every((h) => h.state === 'open')).toBe(true);
  });

  it('CF-13: a plain 401-then-401 alerts per attempt but defers (no order-failing 401 returned)', async () => {
    fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('token invalid', { status: 401 }));
    await operatorFetch('https://example.local/x').catch(() => {});
    // One alert per 401'd operator (2 attempts in a 2-entry pool).
    expect(mockNotifyCredentialExpired).toHaveBeenCalledTimes(2);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds form', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns null for absent / empty / unparseable header', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('   ')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('parses HTTP-date form into a non-negative delta', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    // ~30s in the future, allow timing slack.
    expect(ms!).toBeGreaterThan(20_000);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });

  it('clamps a past HTTP-date to 0', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it('caps a pathologically large value at 5 minutes', () => {
    expect(parseRetryAfterMs('999999')).toBe(5 * 60 * 1000);
  });
});

describe('getOperatorHealth', () => {
  it('lists all operators with their current breaker state', () => {
    validPool();
    const health = getOperatorHealth();
    expect(health).toHaveLength(2);
    expect(health[0]!.state).toBe('closed');
    expect(health[1]!.state).toBe('closed');
  });
});

describe('operatorFetch — pool-exhausted Discord alert', () => {
  it('fires notifyOperatorPoolExhausted once when every operator is OPEN', async () => {
    validPool();
    operatorPoolSize(); // force init while breakers are still closed
    breakerFactoryState.forceOpen = true;

    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );

    expect(mockNotifyExhausted).toHaveBeenCalledTimes(1);
    const [args] = mockNotifyExhausted.mock.calls[0] as [{ poolSize: number; reason: string }];
    expect(args.poolSize).toBe(2);
    expect(args.reason).toBe('All operators unhealthy');
  });

  it('throttles the alert within the 15-minute window (only one fire across consecutive failures)', async () => {
    validPool();
    operatorPoolSize();
    breakerFactoryState.forceOpen = true;

    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );
    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );
    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );

    expect(mockNotifyExhausted).toHaveBeenCalledTimes(1);
  });

  it('fires again after the throttle window is reset (simulating the ~15-min cadence)', async () => {
    validPool();
    operatorPoolSize();
    breakerFactoryState.forceOpen = true;

    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );
    expect(mockNotifyExhausted).toHaveBeenCalledTimes(1);

    // Simulate the 15-minute window elapsing.
    __resetPoolExhaustedAlertForTests();

    await expect(operatorFetch('https://example.local/x')).rejects.toBeInstanceOf(
      OperatorPoolUnavailableError,
    );
    expect(mockNotifyExhausted).toHaveBeenCalledTimes(2);
  });
});
