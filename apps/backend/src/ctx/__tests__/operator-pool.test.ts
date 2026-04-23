import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as CircuitBreakerModule from '../../circuit-breaker.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// The pool fires a Discord alert on exhaustion. Mock the module so
// tests assert on the spy without actually reaching fetch(). Keeping
// the mock here (not in a separate file) keeps the test-scope narrow.
const { mockNotifyExhausted } = vi.hoisted(() => ({
  mockNotifyExhausted: vi.fn(),
}));
vi.mock('../../discord.js', () => ({
  notifyOperatorPoolExhausted: mockNotifyExhausted,
}));

/**
 * The breaker mock lets tests force "every operator is open" without
 * spamming fetch to trip real breakers. Default factory returns a
 * closed breaker that passes fetches through; tests that need
 * exhaustion flip `breakerFactoryState.forceOpen = true` BEFORE
 * the pool inits.
 */
const { breakerFactoryState } = vi.hoisted(() => ({
  breakerFactoryState: { forceOpen: false },
}));
vi.mock('../../circuit-breaker.js', async (importActual) => {
  const actual = (await importActual()) as typeof CircuitBreakerModule;
  return {
    ...actual,
    createCircuitBreaker: () => ({
      // Returning 'open' short-circuits pickHealthyOperator — it skips
      // every operator and returns null, tripping the exhausted path.
      getState: () => (breakerFactoryState.forceOpen ? 'open' : 'closed'),
      getStats: () => ({
        state: breakerFactoryState.forceOpen ? 'open' : 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      }),
      fetch: (url: string | URL, init?: RequestInit) => fetch(url, init),
      reset: () => {},
    }),
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
} from '../operator-pool.js';

// The pool snapshots env at first access; resetting the module state
// between tests makes the suite order-independent.
beforeEach(() => {
  __resetOperatorPoolForTests();
  __resetPoolExhaustedAlertForTests();
  mockNotifyExhausted.mockReset();
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

  it('injects Authorization: Bearer <operator> on the outgoing request', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    });
    await operatorFetch('https://example.local/orders', {
      method: 'POST',
      headers: { 'X-Client-Id': 'loopops' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(captured).toHaveLength(1);
    const h = new Headers(captured[0]!.init?.headers);
    expect(h.get('Authorization')).toMatch(/^Bearer bearer-[12]$/);
    expect(h.get('X-Client-Id')).toBe('loopops');
    expect(captured[0]!.init?.method).toBe('POST');
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

  it('surfaces non-CircuitOpen errors from fetch to the caller without retry', async () => {
    const err = new Error('connection reset');
    fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(err);
    await expect(operatorFetch('https://example.local/x')).rejects.toBe(err);
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
