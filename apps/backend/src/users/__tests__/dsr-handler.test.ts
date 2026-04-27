/**
 * Handler-layer tests for `dsrExportHandler` + `dsrDeleteHandler`
 * (A2-1905 / A2-1906). These complement the helper-layer tests in
 * `dsr-export.test.ts` + `dsr-delete.test.ts` which exercise the
 * underlying anonymisation + export logic; this file covers the
 * thin wrapper that sits in front (auth resolution, status mapping,
 * the 401 / 404 / 409 / 500 envelopes, and the Content-Disposition
 * header on the export download).
 *
 * Closes the per-file coverage gap on `dsr-handler.ts` (was 3% per
 * the `npm run test:coverage` snapshot — every wrapper branch was
 * untested).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

const state = vi.hoisted(() => ({
  /** When false, `c.get('auth')` returns undefined → 401 path. */
  authPresent: true,
  /** When false, `getUserById` returns null → 401 path. */
  userPresent: true,
  /** When set, `getUserById` throws → 500 path on auth-resolve. */
  authResolveError: null as Error | null,
  /** Return value (or null) of buildDsrExport. */
  exportPayload: { schemaVersion: 1 as const } as Record<string, unknown> | null,
  /** When set, buildDsrExport throws → 500 path. */
  exportError: null as Error | null,
  /** Result for deleteUserViaAnonymisation. */
  deleteResult: { ok: true } as
    | { ok: true }
    | { ok: false; blockedBy: 'pending_payouts' | 'in_flight_orders' },
  /** When set, deleteUserViaAnonymisation throws → 500 path. */
  deleteError: null as Error | null,
}));

const baseUser = {
  id: 'user-uuid',
  email: 'a@b.com',
  isAdmin: false,
  homeCurrency: 'GBP',
  stellarAddress: null,
  ctxUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => {
    if (state.authResolveError !== null) throw state.authResolveError;
    return state.userPresent ? baseUser : null;
  }),
}));

vi.mock('../dsr-export.js', () => ({
  buildDsrExport: vi.fn(async () => {
    if (state.exportError !== null) throw state.exportError;
    return state.exportPayload;
  }),
}));

vi.mock('../dsr-delete.js', () => ({
  deleteUserViaAnonymisation: vi.fn(async () => {
    if (state.deleteError !== null) throw state.deleteError;
    return state.deleteResult;
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { dsrExportHandler, dsrDeleteHandler } from '../dsr-handler.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-jwt',
};

function makeCtx(): Context {
  return {
    req: { query: (_k: string) => undefined, param: (_k: string) => undefined },
    get: (key: string) => {
      if (key !== 'auth') return undefined;
      return state.authPresent ? LOOP_AUTH : undefined;
    },
    json: (body: unknown, status?: number, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.authPresent = true;
  state.userPresent = true;
  state.authResolveError = null;
  state.exportPayload = { schemaVersion: 1 };
  state.exportError = null;
  state.deleteResult = { ok: true };
  state.deleteError = null;
});

describe('dsrExportHandler', () => {
  it('401s when the auth context is missing', async () => {
    state.authPresent = false;
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('401s when the bearer is loop-shaped but the user row is missing', async () => {
    // `resolveLoopAuthenticatedUser` returns null when getUserById
    // returns null — the wrapper treats that as 401, same as no
    // auth context.
    state.userPresent = false;
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(401);
  });

  it('500s when auth resolution throws', async () => {
    state.authResolveError = new Error('postgres unreachable');
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('returns the export envelope on success with a download Content-Disposition', async () => {
    state.exportPayload = {
      schemaVersion: 1,
      user: { id: 'user-uuid', email: 'a@b.com' },
      orders: [],
      pendingPayouts: [],
    };
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="loop-data-export-user-uuid.json"',
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(state.exportPayload);
  });

  it('404s when buildDsrExport returns null (deleted-while-loaded edge case)', async () => {
    state.exportPayload = null;
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('500s when buildDsrExport throws', async () => {
    state.exportError = new Error('row scan failed');
    const res = await dsrExportHandler(makeCtx());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Failed to build export');
  });
});

describe('dsrDeleteHandler', () => {
  it('401s when the auth context is missing', async () => {
    state.authPresent = false;
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('500s when auth resolution throws', async () => {
    state.authResolveError = new Error('postgres unreachable');
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('returns ok:true on successful anonymisation', async () => {
    state.deleteResult = { ok: true };
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it('returns 409 PENDING_PAYOUTS when a payout is mid-flight', async () => {
    state.deleteResult = { ok: false, blockedBy: 'pending_payouts' };
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('PENDING_PAYOUTS');
    expect(body.message).toContain('cashback payout');
  });

  it('returns 409 IN_FLIGHT_ORDERS when an order is mid-fulfilment', async () => {
    state.deleteResult = { ok: false, blockedBy: 'in_flight_orders' };
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('IN_FLIGHT_ORDERS');
    expect(body.message).toContain('mid-fulfilment');
  });

  it('500s when the anonymisation helper throws', async () => {
    state.deleteError = new Error('txn rolled back');
    const res = await dsrDeleteHandler(makeCtx());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Failed to delete account');
  });
});
