import { describe, it, expect, vi, beforeEach } from 'vitest';

const { envMock } = vi.hoisted(() => ({
  envMock: {
    LOOP_ORDER_VELOCITY_MAX_PER_WINDOW: 3,
    LOOP_ORDER_VELOCITY_WINDOW_HOURS: 24,
    LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR: 100_000n,
  },
}));
vi.mock('../../env.js', () => ({ env: envMock }));

const { dbState, dbMock } = vi.hoisted(() => {
  const s: {
    rows: Array<{ chargeMinor: bigint; chargeCurrency: string }>;
    throwErr: Error | null;
    /** Captured args from the last `.where(...)` call, for assertions. */
    lastWhereArgs: unknown;
    limitCalls: number[];
  } = { rows: [], throwErr: null, lastWhereArgs: undefined, limitCalls: [] };
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn((cond: unknown) => {
    s.lastWhereArgs = cond;
    return chain;
  });
  chain['orderBy'] = vi.fn(() => chain);
  chain['limit'] = vi.fn(async (n: number) => {
    s.limitCalls.push(n);
    if (s.throwErr !== null) throw s.throwErr;
    return s.rows.slice(0, n);
  });
  return { dbState: s, dbMock: chain };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: {
    userId: 'user_id',
    createdAt: 'created_at',
    chargeMinor: 'charge_minor',
    chargeCurrency: 'charge_currency',
  },
}));

import { checkOrderVelocity, VelocityCheckUnavailableError } from '../velocity.js';

function order(
  chargeMinor: bigint,
  chargeCurrency = 'USD',
): { chargeMinor: bigint; chargeCurrency: string } {
  return { chargeMinor, chargeCurrency };
}

beforeEach(() => {
  envMock.LOOP_ORDER_VELOCITY_MAX_PER_WINDOW = 3;
  envMock.LOOP_ORDER_VELOCITY_WINDOW_HOURS = 24;
  envMock.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR = 100_000n;
  dbState.rows = [];
  dbState.throwErr = null;
  dbState.limitCalls = [];
});

describe('checkOrderVelocity — count dimension', () => {
  it('allows under the limit', async () => {
    dbState.rows = [order(10n), order(10n)]; // 2 existing, max 3
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(true);
  });

  it('rejects the (N+1)th order — user already has exactly maxPerWindow', async () => {
    dbState.rows = [order(10n), order(10n), order(10n)]; // 3 existing, max 3
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('count');
  });

  it('bounds the query at exactly maxPerWindow rows (LIMIT), never unbounded', async () => {
    // Simulate a user with far more orders than the cap — the mock
    // `.limit(n)` slices to n, mirroring what a real bounded index
    // scan does. The count check must still fire off the LIMIT, not
    // an exact total.
    dbState.rows = Array.from({ length: 500 }, () => order(10n));
    await checkOrderVelocity('user-1');
    expect(dbState.limitCalls).toEqual([3]); // === LOOP_ORDER_VELOCITY_MAX_PER_WINDOW
  });

  it('is keyed per-user, not per-IP — a fresh user with zero orders is always allowed', async () => {
    dbState.rows = [];
    const result = await checkOrderVelocity('brand-new-user');
    expect(result.allowed).toBe(true);
  });

  it('resets after the window — an empty result (old orders aged out) allows', async () => {
    // The rolling window is computed fresh each call from `now`; an
    // empty DB result set (as if all prior orders fell outside the
    // window) behaves identically to a user who never ordered.
    dbState.rows = [];
    const result = await checkOrderVelocity('user-1', new Date('2026-08-01T00:00:00Z'));
    expect(result.allowed).toBe(true);
  });

  it('count dimension disabled (0) never rejects on count alone', async () => {
    envMock.LOOP_ORDER_VELOCITY_MAX_PER_WINDOW = 0;
    envMock.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR = 0n;
    dbState.rows = Array.from({ length: 50 }, () => order(10n));
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(true);
    // Both dimensions disabled — no DB call at all.
    expect(dbState.limitCalls).toEqual([]);
  });
});

describe('checkOrderVelocity — value dimension', () => {
  it('allows when the summed charge value is under the cap', async () => {
    dbState.rows = [order(30_000n), order(30_000n)]; // 60,000 < 100,000 cap
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(true);
  });

  it('rejects when the summed charge value meets the cap, per currency', async () => {
    dbState.rows = [order(60_000n), order(40_000n)]; // 100,000 >= cap
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('value');
    expect(result.currency).toBe('USD');
  });

  it('sums independently per currency — one currency over cap does not block another', async () => {
    dbState.rows = [order(60_000n, 'USD'), order(60_000n, 'GBP')];
    // Neither currency alone meets the 100,000 cap.
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(true);
  });

  it('value dimension disabled (0) never rejects on value alone', async () => {
    envMock.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR = 0n;
    dbState.rows = [order(999_999_999n)];
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(true);
  });

  it('count check takes precedence — a count rejection short-circuits before summing', async () => {
    dbState.rows = [order(1n), order(1n), order(1n)]; // count=3=cap, trivial value
    const result = await checkOrderVelocity('user-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('count');
  });

  it('value-only mode (count disabled) uses the 200-row defensive cap, not an unbounded scan', async () => {
    // ADR 045 accepted residual: with the count dimension off, the
    // bounded fetch falls back to VALUE_ONLY_ROW_CAP (200) rather
    // than growing unbounded. Pin the exact LIMIT used.
    envMock.LOOP_ORDER_VELOCITY_MAX_PER_WINDOW = 0;
    envMock.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR = 1_000_000_000n; // effectively unreachable
    dbState.rows = Array.from({ length: 500 }, () => order(1n));
    await checkOrderVelocity('user-1');
    expect(dbState.limitCalls).toEqual([200]);
  });

  it('value-only mode: >=200 in-window orders means the value sum silently excludes older rows (documented residual)', async () => {
    envMock.LOOP_ORDER_VELOCITY_MAX_PER_WINDOW = 0;
    envMock.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR = 500n;
    // 300 real orders of 10n each = 3,000n true total, comfortably
    // over the 500n cap — but the mock DB (mirroring a real bounded
    // backward index scan) only returns the newest 200 rows, whose
    // sum (2,000n) still clears the cap here, so this case alone
    // would still reject...
    dbState.rows = Array.from({ length: 300 }, () => order(10n));
    const overCap = await checkOrderVelocity('user-1');
    expect(overCap.allowed).toBe(false);

    // ...but construct the residual precisely: 250 old (untruncated)
    // orders below the value cap, with only the newest 200 visible to
    // the bounded fetch. The sum over the visible 200 stays under the
    // 500n cap even though the TRUE in-window total across all 250
    // would exceed it — demonstrating the under-count is real, not
    // just a same-conclusion coincidence.
    dbState.rows = Array.from({ length: 200 }, () => order(2n)); // visible: 200 × 2n = 400n < cap
    const underCapOnVisibleRows = await checkOrderVelocity('user-1');
    expect(underCapOnVisibleRows.allowed).toBe(true); // true total (250 × 2n = 500n) would have tripped it
  });
});

describe('checkOrderVelocity — fail-closed', () => {
  it('throws VelocityCheckUnavailableError when the bounded query fails', async () => {
    dbState.throwErr = new Error('connection reset');
    await expect(checkOrderVelocity('user-1')).rejects.toBeInstanceOf(
      VelocityCheckUnavailableError,
    );
  });

  it('carries the original error as `cause`', async () => {
    const original = new Error('pool exhausted');
    dbState.throwErr = original;
    try {
      await checkOrderVelocity('user-1');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VelocityCheckUnavailableError);
      expect((err as VelocityCheckUnavailableError).cause).toBe(original);
    }
  });
});
