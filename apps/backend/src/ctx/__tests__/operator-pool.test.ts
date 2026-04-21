import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  operatorFetch,
  operatorPoolSize,
  getOperatorHealth,
  __resetOperatorPoolForTests,
  OperatorPoolUnavailableError,
} from '../operator-pool.js';

// The pool snapshots env at first access; resetting the module state
// between tests makes the suite order-independent.
beforeEach(() => {
  __resetOperatorPoolForTests();
  delete process.env['CTX_OPERATOR_POOL'];
});

afterEach(() => {
  __resetOperatorPoolForTests();
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
